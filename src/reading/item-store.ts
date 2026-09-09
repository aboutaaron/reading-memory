import { randomUUID } from 'node:crypto';
import type { Database } from '../db/connection.js';
import { transaction, rebuildItemFts } from '../db/connection.js';
import { ApiError } from '../api/errors.js';
import { LIMITS } from '../config.js';
import type { Analysis, ExtractedSource, RelatedItem } from './types.js';
import { sha256, stableJson } from '../ingest/content-hash.js';
import { extractSearchTerms, toFtsQuery } from './search-terms.js';

export type IngestResponse = {
  item_id: string;
  status: 'indexed';
  dedupe_status: 'created' | 'existing' | 'content_changed' | 'idempotent_replay' | 'reanalyzed';
  title: string | null;
  source_uri: string | null;
  content_hash: string;
  truncated: boolean;
  author: string | null;
  publisher: string | null;
  published_at: string | null;
  summary: string;
  core_claims: string[];
  tags: Array<{ tag: string; reason: string; confidence: number }>;
  relevance: Analysis['relevance'];
  recommended_action: Analysis['recommended_action'];
  confidence: number;
  reason: string;
  connections: Analysis['relationships'];
  related_items: RelatedItem[];
};

type InFlightIngest = { payloadHash: string; promise: Promise<IngestResponse> };
const inFlightIngests = new WeakMap<Database, Map<string, InFlightIngest>>();

function inFlightFor(db: Database) {
  let pending = inFlightIngests.get(db);
  if (!pending) {
    pending = new Map();
    inFlightIngests.set(db, pending);
  }
  return pending;
}

/** Other write operations share request IDs with ingestion, including while it awaits I/O. */
export function assertNoInFlightIngest(db: Database, principal: string, requestId: string) {
  if (inFlightIngests.get(db)?.has(`${principal}\0${requestId}`)) {
    throw new ApiError('IDEMPOTENCY_CONFLICT', 'request_id is already in progress for an ingest operation', 409);
  }
  if (db.prepare('SELECT 1 FROM analysis_jobs WHERE principal = ? AND request_id = ? AND expires_at > ?')
    .get(principal, requestId, new Date().toISOString())) {
    throw new ApiError('IDEMPOTENCY_CONFLICT', 'request_id is already in progress for a reanalysis operation', 409);
  }
}

export class ItemStore {
  private readonly inFlight: Map<string, InFlightIngest>;

  constructor(private readonly db: Database) {
    this.inFlight = inFlightFor(db);
  }

  async ingest(input: {
    principal: string;
    requestId: string;
    payloadHash: string;
    analyze: (itemId: string, source: ExtractedSource) => Promise<Analysis>;
  } & ({ source: ExtractedSource; extract?: never } | { extract: () => Promise<ExtractedSource>; source?: never })): Promise<IngestResponse> {
    const existingReplay = this.getIdempotency(input.principal, input.requestId);
    if (existingReplay) {
      if (existingReplay.payload_hash !== input.payloadHash) {
        throw new ApiError('IDEMPOTENCY_CONFLICT', 'request_id has already been used with a different payload', 409);
      }
      return normalizeIngestReplay(this.db, parseReplaySnapshot(existingReplay.response_snapshot));
    }

    const inFlightKey = `${input.principal}\0${input.requestId}`;
    const existingInFlight = this.inFlight.get(inFlightKey);
    if (existingInFlight) {
      if (existingInFlight.payloadHash !== input.payloadHash) {
        throw new ApiError('IDEMPOTENCY_CONFLICT', 'request_id is already in progress with a different payload', 409);
      }
      return {
        ...await existingInFlight.promise,
        dedupe_status: 'idempotent_replay'
      };
    }

    assertNoInFlightIngest(this.db, input.principal, input.requestId);

    // A durable monotonic log position distinguishes work already underway when
    // an item was forgotten from a later intentional capture, even within one ms.
    const activityBarrier = Number((this.db.prepare('SELECT coalesce(max(id), 0) AS id FROM activity_log').get() as { id: number }).id);
    // Register the operation before any extraction so concurrent retries share network work.
    const promise = Promise.resolve().then(async () => {
      const source = input.source ?? await input.extract();
      return this.ingestFresh({ ...input, source, activityBarrier, analyze: (itemId) => input.analyze(itemId, source) });
    }).finally(() => this.inFlight.delete(inFlightKey));
    this.inFlight.set(inFlightKey, { payloadHash: input.payloadHash, promise });
    return await promise;
  }

  /** Removes canonical content and every cached response that refers to it. */
  forget(input: { itemId: string; principal: string; requestId?: string }): { item_id: string; deleted: true } {
    return transaction(this.db, () => {
      const item = this.db.prepare('SELECT content_hash, status, ingested_at FROM items WHERE id = ?')
        .get(input.itemId) as { content_hash: string; status: string; ingested_at: string } | undefined;
      if (!item) throw new ApiError('NOT_FOUND', 'Item not found', 404);
      if (item.status === 'analyzing' && !isStaleAnalysis(item.ingested_at, new Date().toISOString())) {
        throw new ApiError('ANALYSIS_IN_PROGRESS', 'This item is being analyzed; retry shortly', 409, true, 10);
      }
      this.assertNoActiveReanalysis(input.itemId);
      // Snapshots can embed another item's quotes in connections, related items,
      // or a multi-item brief event batch whose item_id column is NULL. Keep the
      // key as a tombstone so an old retry cannot recreate or reveal forgotten data.
      this.db.prepare(`UPDATE idempotency_keys SET response_snapshot = '{"forgotten":true}'
        WHERE item_id = ? OR EXISTS (
          SELECT 1 FROM json_tree(idempotency_keys.response_snapshot) WHERE value = ?
        )`).run(input.itemId, input.itemId);
      this.db.prepare('DELETE FROM item_fts WHERE item_id = ?').run(input.itemId);
      this.db.prepare('DELETE FROM items WHERE id = ?').run(input.itemId);
      this.log('item.deleted', input.principal, validOperationalRequestId(input.requestId), null, { content_hash: item.content_hash });
      return { item_id: input.itemId, deleted: true };
    });
  }

  async reanalyze(input: {
    itemId: string;
    principal: string;
    requestId: string;
    analyze: (itemId: string, source: ExtractedSource) => Promise<Analysis>;
  }): Promise<IngestResponse> {
    const payloadHash = sha256(stableJson({ operation: 'item.reanalyze', item_id: input.itemId }));
    const replay = this.getIdempotency(input.principal, input.requestId);
    if (replay) {
      if (replay.payload_hash !== payloadHash) {
        throw new ApiError('IDEMPOTENCY_CONFLICT', 'request_id has already been used with a different payload', 409);
      }
      return normalizeIngestReplay(this.db, parseReplaySnapshot(replay.response_snapshot));
    }
    // A duplicate call on the same item is an explicit busy response, even when
    // it uses the same request ID. Successful retries replay the saved result.
    this.assertNoActiveReanalysis(input.itemId);
    assertNoInFlightIngest(this.db, input.principal, input.requestId);
    const token = randomUUID();
    const source = transaction(this.db, () => {
      const now = new Date().toISOString();
      this.db.prepare('DELETE FROM analysis_jobs WHERE expires_at <= ?').run(now);
      this.deleteExpiredIdempotency(now);
      const row = this.db.prepare('SELECT * FROM items WHERE id = ?').get(input.itemId) as {
        source_type: ExtractedSource['sourceType']; source_uri: string | null; canonical_url: string | null;
        final_url: string | null; title: string | null; extracted_text: string; author: string | null;
        publisher: string | null; published_at: string | null; content_hash: string; raw_bytes_hash: string | null;
        truncated: number; provenance_json: string; status: string;
      } | undefined;
      if (!row) throw new ApiError('NOT_FOUND', 'Item not found', 404);
      if (row.status !== 'indexed') {
        throw new ApiError('ANALYSIS_IN_PROGRESS', 'Only indexed items can be reanalyzed; complete or retry ingest first', 409, true, 10);
      }
      this.assertNoActiveReanalysis(input.itemId);
      this.db.prepare(`INSERT INTO analysis_jobs (item_id, principal, request_id, payload_hash, token, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(input.itemId, input.principal, input.requestId, payloadHash, token,
        new Date(Date.now() + LIMITS.maxSyncResponseSeconds * 1000).toISOString());
      this.log('item.reanalysis_started', input.principal, input.requestId, input.itemId, {});
      return {
        sourceType: row.source_type, sourceUri: row.source_uri, canonicalUrl: row.canonical_url,
        finalUrl: row.final_url, title: row.title, extractedText: row.extracted_text, author: row.author,
        publisher: row.publisher, publishedAt: row.published_at, contentHash: row.content_hash,
        rawBytesHash: row.raw_bytes_hash, truncated: Boolean(row.truncated), provenance: JSON.parse(row.provenance_json)
      } satisfies ExtractedSource;
    });
    try {
      const analysis = await input.analyze(input.itemId, source);
      return transaction(this.db, () => {
        if (!this.db.prepare('SELECT 1 FROM items WHERE id = ?').get(input.itemId)) {
          throw new ApiError('NOT_FOUND', 'Item was forgotten during analysis', 404);
        }
        if (!this.db.prepare('SELECT 1 FROM analysis_jobs WHERE item_id = ? AND token = ? AND expires_at > ?')
          .get(input.itemId, token, new Date().toISOString())) {
          throw new ApiError('ANALYSIS_IN_PROGRESS', 'A newer reanalysis attempt owns this item; retry shortly', 409, true, 10);
        }
        this.db.prepare('DELETE FROM tags WHERE item_id = ?').run(input.itemId);
        this.db.prepare(`DELETE FROM relationships WHERE (from_item_id = ? AND origin = 'model')
          OR (origin = 'heuristic' AND (from_item_id = ? OR to_item_id = ?))`).run(input.itemId, input.itemId, input.itemId);
        const now = new Date().toISOString();
        this.insertAnalysis(input.itemId, analysis, now);
        this.rebuildFts(input.itemId);
        const response = this.toIngestResponse(input.itemId, 'reanalyzed', analysis);
        this.insertIdempotency({ ...input, payloadHash }, response, now, input.itemId);
        this.log('item.reanalyzed', input.principal, input.requestId, input.itemId, {
          analysis_version: analysis.analysis_version, model: analysis.model, tag_count: analysis.tags.length
        });
        return response;
      });
    } catch (error) {
      transaction(this.db, () => {
        const retained = this.db.prepare('SELECT 1 FROM items WHERE id = ?').get(input.itemId);
        this.log('item.reanalysis_failed', input.principal, input.requestId, retained ? input.itemId : null,
          { error_class: error instanceof Error ? error.name : 'UnknownError' });
      });
      throw error;
    } finally {
      this.db.prepare('DELETE FROM analysis_jobs WHERE item_id = ? AND token = ?').run(input.itemId, token);
    }
  }

  private assertNoActiveReanalysis(itemId: string) {
    if (this.db.prepare('SELECT 1 FROM analysis_jobs WHERE item_id = ? AND expires_at > ?')
      .get(itemId, new Date().toISOString())) {
      throw new ApiError('ANALYSIS_IN_PROGRESS', 'This item is already being analyzed; retry shortly', 409, true, 10);
    }
  }

  private async ingestFresh(input: {
    principal: string;
    requestId: string;
    payloadHash: string;
    source: ExtractedSource;
    activityBarrier: number;
    analyze: (itemId: string) => Promise<Analysis>;
  }): Promise<IngestResponse> {
    const now = new Date().toISOString();
    const prepared = transaction(this.db, () => {
      this.deleteExpiredIdempotency(now);
      const forgottenDuringExtraction = this.db.prepare(`SELECT 1 FROM activity_log
        WHERE type = 'item.deleted' AND id > ? AND json_extract(metadata_json, '$.content_hash') = ? LIMIT 1`)
        .get(input.activityBarrier, input.source.contentHash);
      if (forgottenDuringExtraction) {
        this.insertIdempotency(input, { forgotten: true }, now, null);
        return { forgotten: true as const };
      }
      const duplicate = this.findByContentHash(input.source.contentHash);
      if (duplicate) {
        this.assertNoActiveReanalysis(duplicate.id);
        if (duplicate.status === 'analyzing') {
          if (isStaleAnalysis(duplicate.ingested_at, now)) {
            this.db.prepare("UPDATE items SET status = 'analyzing', ingested_at = ? WHERE id = ?").run(now, duplicate.id);
            this.log('ingest.analysis_retry_stale', input.principal, input.requestId, duplicate.id, {
              source_type: input.source.sourceType,
              content_hash: input.source.contentHash
            });
            return { itemId: duplicate.id, dedupeStatus: 'created' as const, attemptStartedAt: now };
          }
          throw new ApiError('ANALYSIS_IN_PROGRESS', 'This content is already being analyzed; retry shortly', 409, true, 10);
        }
        if (duplicate.status === 'failed') {
          this.db.prepare("UPDATE items SET status = 'analyzing', ingested_at = ? WHERE id = ?").run(now, duplicate.id);
          this.log('ingest.analysis_retry', input.principal, input.requestId, duplicate.id, {
            source_type: input.source.sourceType,
            content_hash: input.source.contentHash
          });
          return { itemId: duplicate.id, dedupeStatus: 'created' as const, attemptStartedAt: now };
        }
        const response = this.responseForExisting(duplicate.id, 'existing');
        this.insertIdempotency(input, response, now, duplicate.id);
        this.log('ingest.idempotent_existing', input.principal, input.requestId, duplicate.id, {
          source_type: input.source.sourceType,
          content_hash: input.source.contentHash
        });
        return { response };
      }

      const changedSource = this.findLatestBySource(input.source.canonicalUrl ?? input.source.sourceUri);
      const itemId = `item_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      this.db.prepare(`
        INSERT INTO items (
          id, source_type, source_uri, canonical_url, final_url, title, author, publisher, published_at, ingested_at,
          content_hash, raw_bytes_hash, status, extracted_text, truncated, supersedes_item_id, provenance_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'analyzing', ?, ?, ?, ?)
      `).run(
        itemId,
        input.source.sourceType,
        input.source.sourceUri,
        input.source.canonicalUrl,
        input.source.finalUrl,
        input.source.title,
        input.source.author ?? null,
        input.source.publisher ?? null,
        input.source.publishedAt ?? null,
        now,
        input.source.contentHash,
        input.source.rawBytesHash,
        input.source.extractedText,
        input.source.truncated ? 1 : 0,
        changedSource?.id ?? null,
        JSON.stringify(input.source.provenance)
      );

      if (this.db.prepare("SELECT 1 FROM activity_log WHERE type = 'item.deleted' AND json_extract(metadata_json, '$.content_hash') = ? LIMIT 1").get(input.source.contentHash)) {
        this.log('ingest.previously_forgotten', input.principal, input.requestId, itemId, { content_hash: input.source.contentHash });
      }
      this.log('ingest.analysis_started', input.principal, input.requestId, itemId, {
        source_type: input.source.sourceType,
        content_hash: input.source.contentHash
      });
      return { itemId, dedupeStatus: changedSource ? 'content_changed' as const : 'created' as const, attemptStartedAt: now };
    });

    if ('forgotten' in prepared) {
      throw new ApiError('ITEM_FORGOTTEN', 'This content was forgotten after ingestion began; use a new request_id only for an intentional capture', 410);
    }
    if ('response' in prepared) return prepared.response;

    try {
      const analysis = await input.analyze(prepared.itemId);
      return transaction(this.db, () => {
        if (!this.isCurrentAttempt(prepared.itemId, prepared.attemptStartedAt)) {
          return this.responseForStaleSuccess(prepared.itemId);
        }
        this.insertAnalysis(prepared.itemId, analysis, now);
        this.db.prepare("UPDATE items SET status = 'indexed' WHERE id = ?").run(prepared.itemId);
        this.rebuildFts(prepared.itemId);
        const response = this.toIngestResponse(prepared.itemId, prepared.dedupeStatus, analysis);
        this.insertIdempotency(input, response, now, prepared.itemId);
        this.log('ingest.created', input.principal, input.requestId, prepared.itemId, {
          source_type: input.source.sourceType,
          content_hash: input.source.contentHash,
          tag_count: analysis.tags.length
        });
        return response;
      });
    } catch (error) {
      transaction(this.db, () => {
        const failed = this.db.prepare("UPDATE items SET status = 'failed' WHERE id = ? AND status = 'analyzing' AND ingested_at = ?")
          .run(prepared.itemId, prepared.attemptStartedAt);
        const eventType = failed.changes === 0 ? 'ingest.analysis_failed_stale' : 'ingest.analysis_failed';
        const retainedItem = this.db.prepare('SELECT id FROM items WHERE id = ?').get(prepared.itemId);
        this.log(eventType, input.principal, input.requestId, retainedItem ? prepared.itemId : null, {
          source_type: input.source.sourceType,
          content_hash: input.source.contentHash,
          error_class: error instanceof Error ? error.name : 'UnknownError'
        });
      });
      throw error;
    }
  }

  private insertAnalysis(itemId: string, analysis: Analysis, now: string) {
    this.db.prepare(`
      INSERT INTO analyses (
        id, item_id, summary, reason, claims_json, relevance_json, recommended_action,
        confidence, model, analysis_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `analysis_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      itemId,
      analysis.summary,
      analysis.reason,
      JSON.stringify(analysis.claims),
      JSON.stringify(analysis.relevance),
      analysis.recommended_action,
      analysis.confidence,
      analysis.model,
      analysis.analysis_version,
      now
    );

    const insertTag = this.db.prepare('INSERT OR REPLACE INTO tags (item_id, tag, reason, confidence) VALUES (?, ?, ?, ?)');
    for (const tag of analysis.tags) insertTag.run(itemId, tag.tag, tag.reason, tag.confidence);

    const insertRelationship = this.db.prepare(`
      INSERT OR IGNORE INTO relationships (id, from_item_id, to_item_id, relation_type, explanation, confidence, created_at, origin, evidence_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const relationship of analysis.relationships) {
      insertRelationship.run(
        `rel_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        relationship.from_item_id,
        relationship.to_item_id,
        relationship.relation_type,
        relationship.explanation,
        relationship.confidence,
        now,
        relationship.origin ?? (relationship.evidence ? 'model' : 'heuristic'),
        relationship.evidence ? JSON.stringify(relationship.evidence) : null
      );
    }
  }

  private rebuildFts(itemId: string) {
    rebuildItemFts(this.db, itemId);
  }

  private responseForExisting(itemId: string, dedupeStatus: IngestResponse['dedupe_status']): IngestResponse {
    const analysis = this.latestAnalysis(itemId);
    return this.toIngestResponse(itemId, dedupeStatus, analysis);
  }

  private responseForStaleSuccess(itemId: string): IngestResponse {
    const item = this.db.prepare('SELECT status FROM items WHERE id = ?').get(itemId) as { status: string } | undefined;
    if (!item) throw new ApiError('NOT_FOUND', 'Item was forgotten during analysis', 404);
    if (item?.status === 'indexed') return this.responseForExisting(itemId, 'existing');
    if (item?.status === 'failed') {
      throw new ApiError('ANALYSIS_FAILED', 'A newer analysis attempt failed for this item', 502, true, 30);
    }
    throw new ApiError('ANALYSIS_IN_PROGRESS', 'A newer analysis attempt is still running for this item', 409, true, 10);
  }

  private isCurrentAttempt(itemId: string, attemptStartedAt: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM items WHERE id = ? AND status = 'analyzing' AND ingested_at = ?")
      .get(itemId, attemptStartedAt));
  }

  private toIngestResponse(itemId: string, dedupeStatus: IngestResponse['dedupe_status'], analysis: Analysis): IngestResponse {
    const item = this.db.prepare('SELECT id, title, source_uri, content_hash, truncated, author, publisher, published_at FROM items WHERE id = ?').get(itemId) as {
      id: string;
      title: string | null;
      source_uri: string | null;
      content_hash: string;
      truncated: number;
      author: string | null;
      publisher: string | null;
      published_at: string | null;
    };
    return {
      item_id: item.id,
      status: 'indexed',
      dedupe_status: dedupeStatus,
      title: item.title,
      source_uri: item.source_uri,
      content_hash: item.content_hash,
      truncated: Boolean(item.truncated),
      author: item.author,
      publisher: item.publisher,
      published_at: item.published_at,
      summary: analysis.summary,
      core_claims: analysis.claims,
      tags: analysis.tags,
      relevance: analysis.relevance,
      recommended_action: analysis.recommended_action,
      confidence: analysis.confidence,
      reason: analysis.reason,
      connections: analysis.relationships,
      related_items: this.relatedItems(itemId, item.title, analysis)
    };
  }

  private latestAnalysis(itemId: string): Analysis {
    const row = this.db.prepare(`
      SELECT summary, reason, claims_json, relevance_json, recommended_action, confidence, model, analysis_version
      FROM analyses WHERE item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(itemId) as {
      summary: string;
      reason: string | null;
      claims_json: string;
      relevance_json: string;
      recommended_action: Analysis['recommended_action'];
      confidence: number;
      model: string;
      analysis_version: string;
    };
    const tags = this.db.prepare('SELECT tag, reason, confidence FROM tags WHERE item_id = ? ORDER BY confidence DESC').all(itemId) as Analysis['tags'];
    const relationships = this.db.prepare(`
      SELECT from_item_id, to_item_id, relation_type, explanation, confidence, origin, evidence_json
      FROM relationships WHERE from_item_id = ? OR to_item_id = ?
    `).all(itemId, itemId) as Array<Omit<Analysis['relationships'][number], 'evidence'> & { evidence_json: string | null }>;
    return {
      summary: row.summary,
      claims: JSON.parse(row.claims_json),
      relevance: JSON.parse(row.relevance_json),
      recommended_action: row.recommended_action,
      confidence: row.confidence,
      reason: row.reason ?? 'Original analysis rationale was not recorded for this legacy item.',
      tags,
      relationships: relationships.map(({ evidence_json, ...relationship }) => ({ ...relationship, ...(evidence_json ? { evidence: JSON.parse(evidence_json) } : {}) })),
      model: row.model,
      analysis_version: row.analysis_version
    };
  }

  private getIdempotency(principal: string, requestId: string) {
    return this.db.prepare(`
      SELECT payload_hash, response_snapshot
      FROM idempotency_keys
      WHERE principal = ? AND request_id = ? AND expires_at > ?
    `).get(principal, requestId, new Date().toISOString()) as { payload_hash: string; response_snapshot: string } | undefined;
  }

  private insertIdempotency(
    input: { principal: string; requestId: string; payloadHash: string },
    response: IngestResponse | { forgotten: true },
    now: string,
    itemId: string | null
  ) {
    const expires = new Date(Date.parse(now) + 7 * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare(`
      INSERT INTO idempotency_keys (principal, request_id, payload_hash, item_id, response_snapshot, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.principal, input.requestId, input.payloadHash, itemId, JSON.stringify(response), now, expires);
  }

  private deleteExpiredIdempotency(now: string) {
    this.db.prepare('DELETE FROM idempotency_keys WHERE expires_at <= ?').run(now);
  }

  private findByContentHash(contentHash: string) {
    return this.db.prepare('SELECT id, status, ingested_at FROM items WHERE content_hash = ?').get(contentHash) as {
      id: string;
      status: string;
      ingested_at: string;
    } | undefined;
  }

  private findLatestBySource(source: string | null) {
    if (!source) return undefined;
    return this.db.prepare(`
      SELECT id FROM items
      WHERE canonical_url = ? OR source_uri = ?
      ORDER BY ingested_at DESC LIMIT 1
    `).get(source, source) as { id: string } | undefined;
  }

  private relatedItems(itemId: string, title: string | null, analysis: Analysis): RelatedItem[] {
    const terms = toFtsQuery(extractSearchTerms([
      title,
      analysis.summary,
      ...analysis.claims,
      ...analysis.relevance.themes,
      ...analysis.tags.map((tag) => tag.tag)
    ], 10));
    if (!terms) return [];

    const rows = this.db.prepare(`
      SELECT i.id AS item_id, i.title, i.source_uri, bm25(item_fts) * -1 AS score
      FROM item_fts
      JOIN items i ON i.id = item_fts.item_id
      WHERE item_fts MATCH ?
        AND i.status = 'indexed'
        AND i.id <> ?
      ORDER BY score DESC, i.ingested_at DESC
      LIMIT 5
    `).all(terms, itemId) as Array<{
      item_id: string;
      title: string | null;
      source_uri: string | null;
      score: number;
    }>;

    return rows.map((row) => ({
      item_id: row.item_id,
      title: row.title,
      source_uri: row.source_uri,
      score: row.score,
      match_reason: 'Matched stored reading via title, summary, claims, themes, or tags'
    }));
  }

  private log(type: string, principal: string, requestId: string | null, itemId: string | null, metadata: Record<string, unknown>) {
    this.db.prepare(`
      INSERT INTO activity_log (type, principal, request_id, item_id, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(type, principal, requestId, itemId, JSON.stringify(metadata), new Date().toISOString());
  }
}

function isStaleAnalysis(ingestedAt: string, now: string) {
  return Date.parse(now) - Date.parse(ingestedAt) > LIMITS.maxSyncResponseSeconds * 1000;
}

function normalizeIngestReplay(db: Database, snapshot: IngestResponse): IngestResponse {
  const item = db.prepare('SELECT truncated, author, publisher, published_at FROM items WHERE id = ?')
    .get(snapshot.item_id) as { truncated: number; author: string | null; publisher: string | null; published_at: string | null } | undefined;
  return {
    ...snapshot,
    dedupe_status: 'idempotent_replay',
    truncated: Object.hasOwn(snapshot, 'truncated') ? snapshot.truncated : Boolean(item?.truncated),
    author: Object.hasOwn(snapshot, 'author') ? snapshot.author : item?.author ?? null,
    publisher: Object.hasOwn(snapshot, 'publisher') ? snapshot.publisher : item?.publisher ?? null,
    published_at: Object.hasOwn(snapshot, 'published_at') ? snapshot.published_at : item?.published_at ?? null,
    related_items: Array.isArray(snapshot.related_items) ? snapshot.related_items : []
  };
}

/** Invalidated cached responses must not replay forgotten content from any API. */
export function parseReplaySnapshot<T = IngestResponse>(snapshot: string): T {
  const value = JSON.parse(snapshot);
  if (value?.forgotten === true) {
    throw new ApiError('ITEM_FORGOTTEN', 'This request referenced forgotten content; use a new request_id for an intentional new operation', 410);
  }
  return value as T;
}

function validOperationalRequestId(requestId: string | undefined): string | null {
  return requestId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId) ? requestId : null;
}
