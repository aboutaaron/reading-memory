import { randomUUID } from 'node:crypto';
import type { Database } from '../db/connection.js';
import { transaction } from '../db/connection.js';
import { ApiError } from '../api/errors.js';
import { LIMITS } from '../config.js';
import type { Analysis, ExtractedSource } from './types.js';

export type IngestResponse = {
  item_id: string;
  status: 'indexed';
  dedupe_status: 'created' | 'existing' | 'content_changed' | 'idempotent_replay';
  title: string | null;
  source_uri: string | null;
  content_hash: string;
  summary: string;
  core_claims: string[];
  tags: Array<{ tag: string; reason: string; confidence: number }>;
  relevance: Analysis['relevance'];
  recommended_action: Analysis['recommended_action'];
  confidence: number;
  reason: string;
  connections: Analysis['relationships'];
};

export class ItemStore {
  private readonly inFlight = new Map<string, { payloadHash: string; promise: Promise<IngestResponse> }>();

  constructor(private readonly db: Database) {}

  async ingest(input: {
    principal: string;
    requestId: string;
    payloadHash: string;
    source: ExtractedSource;
    analyze: (itemId: string) => Promise<Analysis>;
  }): Promise<IngestResponse> {
    const existingReplay = this.getIdempotency(input.principal, input.requestId);
    if (existingReplay) {
      if (existingReplay.payload_hash !== input.payloadHash) {
        throw new ApiError('IDEMPOTENCY_CONFLICT', 'request_id has already been used with a different payload', 409);
      }
      return { ...JSON.parse(existingReplay.response_snapshot), dedupe_status: 'idempotent_replay' };
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

    const promise = this.ingestFresh(input).finally(() => this.inFlight.delete(inFlightKey));
    this.inFlight.set(inFlightKey, { payloadHash: input.payloadHash, promise });
    return await promise;
  }

  private async ingestFresh(input: {
    principal: string;
    requestId: string;
    payloadHash: string;
    source: ExtractedSource;
    analyze: (itemId: string) => Promise<Analysis>;
  }): Promise<IngestResponse> {
    const now = new Date().toISOString();
    const prepared = transaction(this.db, () => {
      this.deleteExpiredIdempotency(now);
      const duplicate = this.findByContentHash(input.source.contentHash);
      if (duplicate) {
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
          id, source_type, source_uri, canonical_url, final_url, title, ingested_at,
          content_hash, raw_bytes_hash, status, extracted_text, truncated, supersedes_item_id, provenance_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'analyzing', ?, ?, ?, ?)
      `).run(
        itemId,
        input.source.sourceType,
        input.source.sourceUri,
        input.source.canonicalUrl,
        input.source.finalUrl,
        input.source.title,
        now,
        input.source.contentHash,
        input.source.rawBytesHash,
        input.source.extractedText,
        input.source.truncated ? 1 : 0,
        changedSource?.id ?? null,
        JSON.stringify(input.source.provenance)
      );

      this.log('ingest.analysis_started', input.principal, input.requestId, itemId, {
        source_type: input.source.sourceType,
        content_hash: input.source.contentHash
      });
      return { itemId, dedupeStatus: changedSource ? 'content_changed' as const : 'created' as const, attemptStartedAt: now };
    });

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
        this.log(eventType, input.principal, input.requestId, prepared.itemId, {
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
        id, item_id, summary, claims_json, relevance_json, recommended_action,
        confidence, model, analysis_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `analysis_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      itemId,
      analysis.summary,
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
      INSERT OR IGNORE INTO relationships (id, from_item_id, to_item_id, relation_type, explanation, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const relationship of analysis.relationships) {
      insertRelationship.run(
        `rel_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        relationship.from_item_id,
        relationship.to_item_id,
        relationship.relation_type,
        relationship.explanation,
        relationship.confidence,
        now
      );
    }
  }

  private rebuildFts(itemId: string) {
    this.db.prepare('DELETE FROM item_fts WHERE item_id = ?').run(itemId);
    this.db.prepare(`
      INSERT INTO item_fts (item_id, title, body, summary, tags)
      SELECT i.id, coalesce(i.title, ''), i.extracted_text, coalesce(a.summary, ''), coalesce(group_concat(t.tag, ' '), '')
      FROM items i
      LEFT JOIN analyses a ON a.item_id = i.id
      LEFT JOIN tags t ON t.item_id = i.id
      WHERE i.id = ?
      GROUP BY i.id
    `).run(itemId);
  }

  private responseForExisting(itemId: string, dedupeStatus: IngestResponse['dedupe_status']): IngestResponse {
    const analysis = this.latestAnalysis(itemId);
    return this.toIngestResponse(itemId, dedupeStatus, analysis);
  }

  private responseForStaleSuccess(itemId: string): IngestResponse {
    const item = this.db.prepare('SELECT status FROM items WHERE id = ?').get(itemId) as { status: string } | undefined;
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
    const item = this.db.prepare('SELECT id, title, source_uri, content_hash FROM items WHERE id = ?').get(itemId) as {
      id: string;
      title: string | null;
      source_uri: string | null;
      content_hash: string;
    };
    return {
      item_id: item.id,
      status: 'indexed',
      dedupe_status: dedupeStatus,
      title: item.title,
      source_uri: item.source_uri,
      content_hash: item.content_hash,
      summary: analysis.summary,
      core_claims: analysis.claims,
      tags: analysis.tags,
      relevance: analysis.relevance,
      recommended_action: analysis.recommended_action,
      confidence: analysis.confidence,
      reason: analysis.reason,
      connections: analysis.relationships
    };
  }

  private latestAnalysis(itemId: string): Analysis {
    const row = this.db.prepare(`
      SELECT summary, claims_json, relevance_json, recommended_action, confidence, model, analysis_version
      FROM analyses WHERE item_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(itemId) as {
      summary: string;
      claims_json: string;
      relevance_json: string;
      recommended_action: Analysis['recommended_action'];
      confidence: number;
      model: string;
      analysis_version: string;
    };
    const tags = this.db.prepare('SELECT tag, reason, confidence FROM tags WHERE item_id = ? ORDER BY confidence DESC').all(itemId) as Analysis['tags'];
    const relationships = this.db.prepare(`
      SELECT from_item_id, to_item_id, relation_type, explanation, confidence
      FROM relationships WHERE from_item_id = ? OR to_item_id = ?
    `).all(itemId, itemId) as Analysis['relationships'];
    return {
      summary: row.summary,
      claims: JSON.parse(row.claims_json),
      relevance: JSON.parse(row.relevance_json),
      recommended_action: row.recommended_action,
      confidence: row.confidence,
      reason: tags.length ? `Matched themes: ${tags.map((tag) => tag.tag).join(', ')}` : 'Stored for recall; no strong theme match.',
      tags,
      relationships,
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
    response: IngestResponse,
    now: string,
    itemId: string
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

  private log(type: string, principal: string, requestId: string, itemId: string | null, metadata: Record<string, unknown>) {
    this.db.prepare(`
      INSERT INTO activity_log (type, principal, request_id, item_id, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(type, principal, requestId, itemId, JSON.stringify(metadata), new Date().toISOString());
  }
}

function isStaleAnalysis(ingestedAt: string, now: string) {
  return Date.parse(now) - Date.parse(ingestedAt) > LIMITS.maxSyncResponseSeconds * 1000;
}
