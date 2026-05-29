import { randomUUID } from 'node:crypto';
import type { Database } from '../db/connection.js';
import { transaction } from '../db/connection.js';
import { ApiError } from '../api/errors.js';
import type { BriefEventsRequest } from '../api/contracts.js';
import { sha256, stableJson } from '../ingest/content-hash.js';

export type BriefEventRecord = {
  id: string;
  item_id: string;
  brief_date: string;
  event_kind: 'included' | 'skipped' | 'resurfaced';
  included_bool: boolean;
  rationale: string;
  source_context: string;
  resurface_after: string | null;
  created_at: string;
};

export type BriefEventsResponse = {
  events: BriefEventRecord[];
  dedupe_status: 'created' | 'idempotent_replay' | 'existing';
};

export function briefEventsPayloadHash(input: BriefEventsRequest) {
  return sha256(stableJson({
    events: input.events.map((event) => ({
      item_id: event.item_id,
      brief_date: event.brief_date,
      event_kind: event.event_kind,
      included_bool: event.included_bool,
      rationale: event.rationale,
      source_context: event.source_context ?? '',
      resurface_after: event.resurface_after ?? null
    }))
  }));
}

export class BriefEventStore {
  constructor(private readonly db: Database) {}

  record(input: {
    principal: string;
    requestId: string;
    payloadHash: string;
    body: BriefEventsRequest;
  }): BriefEventsResponse {
    const now = new Date().toISOString();
    return transaction(this.db, () => {
      this.deleteExpiredIdempotency(now);
      const replay = this.getIdempotency(input.principal, input.requestId);
      if (replay) {
        if (replay.payload_hash !== input.payloadHash) {
          throw new ApiError('IDEMPOTENCY_CONFLICT', 'request_id has already been used with a different payload', 409);
        }
        return {
          ...JSON.parse(replay.response_snapshot) as BriefEventsResponse,
          dedupe_status: 'idempotent_replay'
        };
      }

      const events: BriefEventRecord[] = [];
      let existingCount = 0;
      for (const event of input.body.events) {
        assertEventKindMatchesIncluded(event.event_kind, event.included_bool);
        this.assertItemExists(event.item_id);
        const sourceContext = event.source_context ?? '';
        const existing = this.findExisting(event.item_id, event.brief_date, event.event_kind, sourceContext);
        if (existing) {
          if (
            existing.included_bool !== event.included_bool ||
            existing.rationale !== event.rationale ||
            existing.resurface_after !== (event.resurface_after ?? null)
          ) {
            throw new ApiError('IDEMPOTENCY_CONFLICT', 'brief event already exists with different details', 409);
          }
          events.push(existing);
          existingCount += 1;
          continue;
        }

        const created: BriefEventRecord = {
          id: `brief_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          item_id: event.item_id,
          brief_date: event.brief_date,
          event_kind: event.event_kind,
          included_bool: event.included_bool,
          rationale: event.rationale,
          source_context: sourceContext,
          resurface_after: event.resurface_after ?? null,
          created_at: now
        };
        this.db.prepare(`
          INSERT INTO brief_events (
            id, item_id, brief_date, event_kind, included_bool, rationale,
            source_context, resurface_after, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          created.id,
          created.item_id,
          created.brief_date,
          created.event_kind,
          created.included_bool ? 1 : 0,
          created.rationale,
          created.source_context,
          created.resurface_after,
          created.created_at
        );
        events.push(created);
      }

      const response: BriefEventsResponse = {
        events,
        dedupe_status: existingCount === events.length ? 'existing' : 'created'
      };
      this.insertIdempotency(input, response, now);
      return response;
    });
  }

  private assertItemExists(itemId: string) {
    const row = this.db.prepare('SELECT 1 AS ok FROM items WHERE id = ?').get(itemId) as { ok: number } | undefined;
    if (!row) throw new ApiError('NOT_FOUND', `Item not found: ${itemId}`, 404);
  }

  private findExisting(itemId: string, briefDate: string, eventKind: string, sourceContext: string) {
    const row = this.db.prepare(`
      SELECT id, item_id, brief_date, event_kind, included_bool, rationale, source_context, resurface_after, created_at
      FROM brief_events
      WHERE item_id = ? AND brief_date = ? AND event_kind = ? AND source_context = ?
    `).get(itemId, briefDate, eventKind, sourceContext) as (Omit<BriefEventRecord, 'included_bool'> & { included_bool: number }) | undefined;
    return row ? normalizeEvent(row) : null;
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
    response: BriefEventsResponse,
    now: string
  ) {
    const expires = new Date(Date.parse(now) + 7 * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare(`
      INSERT INTO idempotency_keys (principal, request_id, payload_hash, item_id, response_snapshot, created_at, expires_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?)
    `).run(input.principal, input.requestId, input.payloadHash, JSON.stringify(response), now, expires);
  }

  private deleteExpiredIdempotency(now: string) {
    this.db.prepare('DELETE FROM idempotency_keys WHERE expires_at <= ?').run(now);
  }
}

function assertEventKindMatchesIncluded(eventKind: string, included: boolean) {
  if (eventKind === 'skipped' && included) {
    throw new ApiError('BAD_REQUEST', 'skipped brief events must set included_bool to false', 400);
  }
  if (eventKind !== 'skipped' && !included) {
    throw new ApiError('BAD_REQUEST', 'included or resurfaced brief events must set included_bool to true', 400);
  }
}

function normalizeEvent(row: Omit<BriefEventRecord, 'included_bool'> & { included_bool: number }): BriefEventRecord {
  return {
    ...row,
    included_bool: row.included_bool === 1
  };
}
