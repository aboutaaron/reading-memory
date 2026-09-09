import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase } from '../db/connection.js';
import { ApiError } from '../api/errors.js';
import { listFailedCaptures, safeFailureMetadata } from './failed-captures.js';
import { ItemStore } from './item-store.js';
import type { Analysis, ExtractedSource } from './types.js';

const source: ExtractedSource = {
  sourceType: 'pdf_url', sourceUri: 'https://example.com/original.pdf', canonicalUrl: 'https://example.com/original.pdf',
  finalUrl: 'https://example.com/final.pdf', title: 'Reading', extractedText: 'Private original content.',
  contentHash: 'sha256:original', rawBytesHash: 'sha256:raw', truncated: false,
  provenance: { original_url: 'https://example.com/original.pdf', source_context: 'Private reading context', extractor: 'pdf' }
};
const analysis: Analysis = {
  summary: 'Reading summary.', claims: [], relevance: { score: 0.5, themes: [] }, recommended_action: 'save',
  confidence: 0.5, reason: 'Useful.', tags: [], relationships: [], model: 'test', analysis_version: 'test'
};

test('failed capture diagnostics have a stable bounded page and unknown legacy causes', (t) => {
  const db = openMemoryDatabase(); t.after(() => db.close());
  const insert = db.prepare(`INSERT INTO items (id, source_type, title, ingested_at, content_hash, status, extracted_text)
    VALUES (?, 'text', 'Reading', '2026-09-09', ?, ?, ?)`);
  insert.run('a', 'a', 'failed', 'Private original content.');
  insert.run('b', 'b', 'failed', '');
  insert.run('c', 'c', 'indexed', 'Indexed');
  insert.run('d', 'd', 'analyzing', 'Analyzing');
  db.prepare(`INSERT INTO activity_log(type, principal, item_id, request_id, metadata_json, created_at)
    VALUES ('ingest.analysis_failed', 'test', 'a', 'original-request', ?, '2026-09-09')`)
    .run(JSON.stringify({ error_class: 'ApiError', message: 'Private secret', retryable: true }));
  const before = db.prepare('SELECT total_changes() AS n').get();
  const first = listFailedCaptures(db, { limit: 1 });
  assert.equal(first.total, 2); assert.equal(first.next_offset, 1);
  assert.equal(first.items[0]?.item_id, 'a');
  assert.equal(first.items[0]?.failure_stage, 'analysis');
  assert.equal(first.items[0]?.recovery, 'retry_original_ingest');
  assert.equal(first.items[0]?.retry_disposition, 'unknown');
  assert.deepEqual(first.items[0]?.latest_failure, { at: '2026-09-09', request_id: 'original-request', code: null, retryable: null });
  const second = listFailedCaptures(db, { limit: 1, offset: first.next_offset! });
  assert.equal(second.items[0]?.item_id, 'b');
  assert.equal(second.items[0]?.recovery, 'recapture_original_source');
  assert.equal(second.items[0]?.failure_stage, 'unknown');
  assert.equal(second.items[0]?.latest_failure, null);
  assert.equal(second.next_offset, null);
  const empty = listFailedCaptures(db, { offset: 99 });
  assert.deepEqual(empty.items, []); assert.equal(empty.total, 2); assert.equal(empty.next_offset, null);
  assert.doesNotMatch(JSON.stringify(first), /Private|error_class|ApiError|extracted_text|metadata_json|provenance/);
  assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), before);
});

test('failed capture bounds reject unsafe or nonintegral offsets and limits', (t) => {
  const db = openMemoryDatabase(); t.after(() => db.close());
  for (const options of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { offset: -1 },
    { offset: Number.MAX_SAFE_INTEGER + 1 }, { offset: Infinity }, { offset: NaN }]) {
    assert.throws(() => listFailedCaptures(db, options), (error: unknown) => error instanceof ApiError && error.code === 'BAD_REQUEST');
  }
  assert.deepEqual(listFailedCaptures(db).items, []);
});

test('only allowlisted ApiError values produce actionable failure metadata', (t) => {
  const db = openMemoryDatabase(); t.after(() => db.close());
  assert.deepEqual(safeFailureMetadata(new ApiError('TIMEOUT', 'Private details', 504, true)), { error_code: 'TIMEOUT', retryable: true });
  assert.deepEqual(safeFailureMetadata({ code: 'TIMEOUT', retryable: true }), { error_code: null, retryable: null });
  const arbitrary = new ApiError('TIMEOUT', 'Private details', 504, true);
  Object.assign(arbitrary, { code: 'PRIVATE_PROVIDER_CODE' });
  assert.deepEqual(safeFailureMetadata(arbitrary), { error_code: null, retryable: null });
  db.prepare(`INSERT INTO items (id, source_type, ingested_at, content_hash, status, extracted_text)
    VALUES ('a', 'text', '2026-09-09', 'a', 'failed', 'Retained')`).run();
  const addEvent = db.prepare(`INSERT INTO activity_log (type, principal, item_id, metadata_json, created_at)
    VALUES ('ingest.analysis_failed', 'test', 'a', ?, '2026-09-09')`);
  addEvent.run(JSON.stringify({ error_code: 'BAD_REQUEST', retryable: false }));
  assert.equal(listFailedCaptures(db).items[0]?.retry_disposition, 'not_retryable');
  assert.equal(listFailedCaptures(db).items[0]?.recovery, 'inspect_failure');
  addEvent.run('{invalid JSON');
  assert.equal(listFailedCaptures(db).items[0]?.retry_disposition, 'unknown');
  addEvent.run(JSON.stringify({ error_code: 'PRIVATE_PROVIDER_CODE', retryable: true }));
  assert.equal(listFailedCaptures(db).items[0]?.latest_failure?.code, null);
  assert.equal(listFailedCaptures(db).items[0]?.retry_disposition, 'unknown');
});

test('retrying the original failed capture indexes the same item with original provenance', async (t) => {
  const db = openMemoryDatabase(); t.after(() => db.close());
  const store = new ItemStore(db);
  const input = { principal: 'test', requestId: 'original-request', payloadHash: 'sha256:request', source };
  await assert.rejects(store.ingest({ ...input, analyze: async () => { throw new ApiError('TIMEOUT', 'Private provider details', 504, true); } }));
  const failed = listFailedCaptures(db).items[0]!;
  assert.equal(failed.retry_disposition, 'retryable');
  assert.equal(failed.latest_failure?.code, 'TIMEOUT');
  const recovered = await store.ingest({ ...input, analyze: async () => analysis });
  assert.equal(recovered.item_id, failed.item_id);
  assert.equal(listFailedCaptures(db).total, 0);
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(recovered.item_id)!;
  assert.equal(row.status, 'indexed'); assert.equal(row.source_type, source.sourceType);
  assert.equal(row.source_uri, source.sourceUri); assert.equal(row.final_url, source.finalUrl);
  assert.equal(row.content_hash, source.contentHash); assert.equal(row.raw_bytes_hash, source.rawBytesHash);
  assert.deepEqual(JSON.parse(row.provenance_json as string), source.provenance);
  assert.equal(db.prepare('SELECT count(*) AS n FROM item_fts WHERE item_id = ?').get(recovered.item_id)?.n, 1);
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT metadata_json FROM activity_log').all()), /Private provider/);
});

test('forgotten failed captures remain deleted when the original request retries', async (t) => {
  const db = openMemoryDatabase(); t.after(() => db.close());
  const store = new ItemStore(db);
  const input = { principal: 'test', requestId: 'original-request', payloadHash: 'sha256:request', source };
  const namedError = new Error('Private message'); namedError.name = 'Private provider name';
  await assert.rejects(store.ingest({ ...input, analyze: async () => { throw namedError; } }));
  const failed = listFailedCaptures(db).items[0]!;
  assert.equal(failed.retry_disposition, 'unknown');
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT metadata_json FROM activity_log').all()), /Private/);
  store.forget({ itemId: failed.item_id, principal: 'test' });
  let calls = 0;
  await assert.rejects(store.ingest({ ...input, analyze: async () => { calls += 1; return analysis; } }),
    (error: unknown) => error instanceof ApiError && error.code === 'ITEM_FORGOTTEN');
  assert.equal(calls, 0); assert.equal(listFailedCaptures(db).total, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM items').get()?.n, 0);
});
