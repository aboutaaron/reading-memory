import { randomUUID } from 'node:crypto';
import { ApiError } from '../api/errors.js';
import type { AnnotationRequest } from '../api/contracts.js';
import { LIMITS } from '../config.js';
import { rebuildItemFts, transaction, type Database } from '../db/connection.js';
import { sha256, stableJson } from '../ingest/content-hash.js';
import { assertNoInFlightIngest } from './item-store.js';

export type ReaderAnnotationRecord = {
  id: string;
  item_id: string;
  actor_type: 'user' | 'agent';
  actor: string;
  note: string;
  project: string | null;
  question: string | null;
  supersedes_annotation_id: string | null;
  created_at: string;
  active: boolean;
};

export type ReaderAnnotationResponse = {
  annotation: ReaderAnnotationRecord;
  dedupe_status: 'created' | 'idempotent_replay';
};

/** History is immutable; only annotations without a successor remain active. */
export function listReaderAnnotations(db: Database, itemId: string): ReaderAnnotationRecord[] {
  const rows = db.prepare(`
    SELECT a.id, a.item_id, a.actor_type, a.actor, a.note, a.project, a.question,
      a.supersedes_annotation_id, a.created_at,
      NOT EXISTS (
        SELECT 1 FROM reader_annotations successor WHERE successor.supersedes_annotation_id = a.id
      ) AS active
    FROM reader_annotations a
    WHERE a.item_id = ?
    ORDER BY a.created_at ASC, a.rowid ASC
  `).all(itemId) as Array<Omit<ReaderAnnotationRecord, 'active'> & { active: number }>;
  return rows.map((row) => ({ ...row, active: row.active === 1 }));
}

export class ReaderAnnotationStore {
  constructor(private readonly db: Database) {}

  record(input: {
    principal: string;
    requestId: string;
    itemId: string;
    body: AnnotationRequest;
  }): ReaderAnnotationResponse {
    assertAnnotation(input.body);
    assertNoInFlightIngest(this.db, input.principal, input.requestId);
    const payloadHash = sha256(stableJson({
      operation: 'reader_annotation.create',
      item_id: input.itemId,
      actor_type: input.body.actor_type,
      actor: input.body.actor,
      note: input.body.note,
      project: input.body.project ?? null,
      question: input.body.question ?? null,
      supersedes_annotation_id: input.body.supersedes_annotation_id ?? null
    }));
    const now = new Date().toISOString();

    return transaction(this.db, () => {
      this.db.prepare('DELETE FROM idempotency_keys WHERE expires_at <= ?').run(now);
      const replay = this.db.prepare(`
        SELECT payload_hash, response_snapshot FROM idempotency_keys
        WHERE principal = ? AND request_id = ?
      `).get(input.principal, input.requestId) as { payload_hash: string; response_snapshot: string } | undefined;
      if (replay) {
        if (replay.payload_hash !== payloadHash) {
          throw new ApiError('IDEMPOTENCY_CONFLICT', 'request_id has already been used with a different payload', 409);
        }
        return {
          ...JSON.parse(replay.response_snapshot) as ReaderAnnotationResponse,
          dedupe_status: 'idempotent_replay'
        };
      }

      const item = this.db.prepare('SELECT id FROM items WHERE id = ?').get(input.itemId);
      if (!item) throw new ApiError('NOT_FOUND', 'Item not found', 404);
      if (input.body.supersedes_annotation_id) {
        this.assertActivePredecessor(input.itemId, input.body.supersedes_annotation_id);
      }

      const annotation: ReaderAnnotationRecord = {
        id: `annotation_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        item_id: input.itemId,
        actor_type: input.body.actor_type,
        actor: input.body.actor,
        note: input.body.note,
        project: input.body.project ?? null,
        question: input.body.question ?? null,
        supersedes_annotation_id: input.body.supersedes_annotation_id ?? null,
        created_at: now,
        active: true
      };
      this.db.prepare(`
        INSERT INTO reader_annotations (
          id, item_id, actor_type, actor, note, project, question, supersedes_annotation_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        annotation.id, annotation.item_id, annotation.actor_type, annotation.actor, annotation.note,
        annotation.project, annotation.question, annotation.supersedes_annotation_id, annotation.created_at
      );
      rebuildItemFts(this.db, input.itemId);

      const response: ReaderAnnotationResponse = { annotation, dedupe_status: 'created' };
      const expires = new Date(Date.parse(now) + LIMITS.idempotencyTtlSeconds * 1000).toISOString();
      this.db.prepare(`
        INSERT INTO idempotency_keys (principal, request_id, payload_hash, item_id, response_snapshot, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(input.principal, input.requestId, payloadHash, input.itemId, JSON.stringify(response), now, expires);
      this.db.prepare(`
        INSERT INTO activity_log (type, principal, request_id, item_id, metadata_json, created_at)
        VALUES ('reader_annotation.created', ?, ?, ?, ?, ?)
      `).run(input.principal, input.requestId, input.itemId, JSON.stringify({
        annotation_id: annotation.id,
        actor_type: annotation.actor_type,
        supersedes_annotation_id: annotation.supersedes_annotation_id
      }), now);
      return response;
    });
  }

  private assertActivePredecessor(itemId: string, predecessorId: string) {
    const predecessor = this.db.prepare('SELECT item_id FROM reader_annotations WHERE id = ?')
      .get(predecessorId) as { item_id: string } | undefined;
    if (!predecessor) throw new ApiError('NOT_FOUND', 'Annotation to supersede was not found', 404);
    if (predecessor.item_id !== itemId) {
      throw new ApiError('BAD_REQUEST', 'A correction must refer to an annotation on the same item', 400);
    }
    const successor = this.db.prepare('SELECT id FROM reader_annotations WHERE supersedes_annotation_id = ?')
      .get(predecessorId);
    if (successor) {
      throw new ApiError('IDEMPOTENCY_CONFLICT', 'Annotation has already been superseded; correct the active annotation instead', 409);
    }
  }
}

function assertAnnotation(body: AnnotationRequest) {
  if (body.actor_type !== 'user' && body.actor_type !== 'agent') {
    throw new ApiError('BAD_REQUEST', 'actor_type must be user or agent', 400);
  }
  assertText('actor', body.actor, 120);
  assertText('note', body.note, 4000);
  if (body.project !== undefined) assertText('project', body.project, 200);
  if (body.question !== undefined) assertText('question', body.question, 1000);
  if (body.supersedes_annotation_id !== undefined) {
    assertText('supersedes_annotation_id', body.supersedes_annotation_id, 200);
  }
}

function assertText(field: string, value: unknown, maxLength: number) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new ApiError('BAD_REQUEST', `${field} must contain text and be at most ${maxLength} characters`, 400);
  }
}
