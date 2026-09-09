import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openMemoryDatabase, type Database } from '../db/connection.js';
import { queryCorpus, getItem } from './corpus-query.js';
import { BriefEventStore, briefEventsPayloadHash, type BriefEventRecord } from './brief-events.js';
import { getUsageStats } from './usage-feedback.js';
import type { BriefEventsRequest } from '../api/contracts.js';

const AS_OF = '2026-09-09T12:00:00.000Z';

function item(db: Database, id: string, { text = 'Cache invalidation requires explicit dependencies.', age = '2026-09-01', relevance = 0.8 } = {}) {
  db.prepare(`INSERT INTO items (id, source_type, title, ingested_at, content_hash, status, extracted_text)
    VALUES (?, 'text', 'Source', ?, ?, 'indexed', ?)`).run(id, `${age}T00:00:00.000Z`, id, text);
  db.prepare('INSERT INTO item_fts (item_id, title, body) VALUES (?, ?, ?)').run(id, 'Source', text);
  db.prepare(`INSERT INTO analyses (id, item_id, summary, relevance_json, recommended_action, confidence, model, analysis_version, created_at)
    VALUES (?, ?, '', ?, 'save', 0.8, 'test', 'test', ?)`).run(id, id, JSON.stringify({ score: relevance }), `${age}T00:00:00.000Z`);
}
function event(db: Database, id: string, kind: BriefEventRecord['event_kind'], date = '2026-09-08', recorded?: string) {
  db.prepare(`INSERT INTO brief_events (id, item_id, brief_date, event_kind, included_bool, rationale, source_context, created_at)
    VALUES (?, ?, ?, ?, ?, 'Actual use or deliberate skip', ?, ?)`)
    .run(randomUUID(), id, date, kind, kind === 'skipped' ? 0 : 1, randomUUID(), recorded ?? `${date}T12:00:00.000Z`);
}
function query(db: Database, mode: 'fts' | 'fts+usage' = 'fts+usage', text = 'cache invalidation') {
  return queryCorpus(db, { query: text, mode, asOf: AS_OF });
}

test('usage breaks equal lexical scores without changing default FTS or adding implicit feedback', (t) => {
  const db = openMemoryDatabase(); t.after(() => db.close());
  item(db, 'a-unused'); item(db, 'z-used');
  event(db, 'z-used', 'cited');
  assert.deepEqual(query(db, 'fts').citations, ['a-unused', 'z-used']);
  const result = query(db);
  assert.deepEqual(result.citations, ['z-used', 'a-unused']);
  assert.equal(result.retrieval_mode, 'fts+usage');
  assert.equal(result.answer, ''); assert.equal(result.confidence, null);
  assert.equal(result.results[0]?.usage?.lexical_score, result.results[1]?.usage?.lexical_score);
  assert.equal(result.results[0]?.usage?.usage_count, 1);
  assert.equal(result.results[1]?.usage?.usage_count, 0);
  assert.match(result.retrieval_hint, /not answer confidence or reader endorsement/);
  for (const row of result.results) assert.equal(row.score, row.usage!.lexical_score * row.usage!.multiplier);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM brief_events').get()?.n, 1);
  assert.equal(Object.hasOwn(query(db, 'fts').results[0]!, 'usage'), false);
});

test('recent actual use outranks old use while skips lower only matching sources with bounded adjustments', (t) => {
  const db = openMemoryDatabase(); t.after(() => db.close());
  for (const id of ['a-old', 'b-unused', 'c-skipped', 'z-recent']) item(db, id);
  event(db, 'a-old', 'included', '2026-01-01'); event(db, 'z-recent', 'cited'); event(db, 'c-skipped', 'skipped');
  item(db, 'unrelated', { text: 'Cooking dinner with fresh vegetables.' });
  for (let i = 0; i < 100; i++) { event(db, 'unrelated', 'cited'); event(db, 'c-skipped', 'skipped'); }
  assert.deepEqual(query(db).citations, ['z-recent', 'a-old', 'b-unused', 'c-skipped']);
  for (const row of query(db).results) assert.ok(row.usage!.multiplier >= 0.7 && row.usage!.multiplier <= 1.2);
  for (const text of ['quasars', 'Can you help me find that article?']) {
    const result = query(db, 'fts+usage', text);
    assert.deepEqual(result.results, []); assert.equal(result.retrieval_mode, 'fts+usage'); assert.equal(result.confidence, 0);
  }
});

test('low-relevance unused reading decays after thirty days and stops at ten percent without hiding it', (t) => {
  const db = openMemoryDatabase(); t.after(() => db.close());
  item(db, 'old-low', { age: '2026-05-01', relevance: 0.1 });
  item(db, 'old-high', { age: '2026-05-01', relevance: 0.8 });
  item(db, 'recent-low', { relevance: 0.1 });
  item(db, 'old-used', { age: '2026-05-01', relevance: 0.1 }); event(db, 'old-used', 'cited');
  const results = query(db).results;
  assert.equal(results.at(-1)?.item_id, 'old-low');
  assert.equal(results.find((r) => r.item_id === 'old-low')?.usage?.unused_decay, 0.1);
  assert.ok(results.filter((r) => r.item_id !== 'old-low').every((r) => r.usage?.unused_decay === 0));
  const beforeThreshold = queryCorpus(db, { query: 'cache', mode: 'fts+usage', asOf: '2026-05-30T00:00:00.000Z' });
  assert.equal(beforeThreshold.results.find((r) => r.item_id === 'old-low')?.usage?.unused_decay, 0);
});

test('usage mode preserves AND priority, partial-term explanations, status, date and tag filters', (t) => {
  const db = openMemoryDatabase(); t.after(() => db.close());
  item(db, 'complete'); item(db, 'partial', { text: 'Cache ownership' }); event(db, 'partial', 'cited');
  item(db, 'failed'); db.exec("UPDATE items SET status = 'failed' WHERE id = 'failed'");
  assert.deepEqual(query(db).citations, ['complete']);
  const partial = query(db, 'fts+usage', 'cache invalidation freshness');
  assert.equal(partial.match_strategy, 'partial_terms');
  assert.deepEqual(partial.results.find((r) => r.item_id === 'complete')?.matched_terms, ['cache', 'invalidation']);
  assert.deepEqual(queryCorpus(db, { query: 'cache', mode: 'fts+usage', tags: ['absent'], asOf: AS_OF }).results, []);
  assert.deepEqual(queryCorpus(db, { query: 'cache', mode: 'fts+usage', since: '2026-09-09', asOf: AS_OF }).results, []);
  assert.equal(queryCorpus(db, { query: 'cache', mode: 'fts+usage', topK: 1, asOf: AS_OF }).results.length, 1);
});

test('item usage counts included and cited records, not skips, resurfacing, or future events', (t) => {
  const db = openMemoryDatabase(); t.after(() => db.close());
  item(db, 'used'); item(db, 'unused');
  event(db, 'used', 'included', '2020-01-01'); event(db, 'used', 'cited', '2020-01-02');
  event(db, 'used', 'skipped', '2020-01-03'); event(db, 'used', 'resurfaced', '2020-01-04');
  event(db, 'used', 'cited', '2099-01-01'); event(db, 'used', 'cited', '2020-01-01', '2099-01-01T00:00:00.000Z');
  assert.equal(getItem(db, 'used')?.usage_count, 2);
  assert.equal(getItem(db, 'used')?.last_used_at, '2020-01-02T12:00:00.000Z');
  assert.equal(getItem(db, 'unused')?.usage_count, 0); assert.equal(getItem(db, 'unused')?.last_used_at, null);
  assert.equal(getUsageStats(db, 'used', '2020-01-01T13:00:00.000Z').usage_count, 1);
});

test('cited events replay and deduplicate safely, reject inconsistent intent, and roll back mixed invalid batches', (t) => {
  const db = openMemoryDatabase(); t.after(() => db.close()); item(db, 'reading');
  const store = new BriefEventStore(db);
  const body: BriefEventsRequest = { request_id: randomUUID(), events: [{ item_id: 'reading', brief_date: '2026-09-09',
    event_kind: 'cited', included_bool: true, rationale: 'Used for the dependency claim in the answer.', source_context: 'answer:123' }] };
  const record = (value: BriefEventsRequest) => store.record({ principal: 'test', requestId: value.request_id, payloadHash: briefEventsPayloadHash(value), body: value });
  assert.equal(record(body).dedupe_status, 'created');
  assert.equal(record(body).dedupe_status, 'idempotent_replay');
  assert.equal(record({ ...body, request_id: randomUUID() }).dedupe_status, 'existing');
  assert.throws(() => record({ ...body, events: [{ ...body.events[0]!, rationale: 'Different intent' }] }), /different payload/);
  assert.throws(() => record({ request_id: randomUUID(), events: [{ ...body.events[0]!, included_bool: false }] }), /included_bool/);
  assert.throws(() => record({ request_id: randomUUID(), events: [{ ...body.events[0]!, resurface_after: '2026-09-10' }] }), /cannot schedule/);
  assert.throws(() => record({ request_id: randomUUID(), events: [
    { ...body.events[0]!, source_context: 'answer:456' }, { ...body.events[0]!, item_id: 'missing' }
  ] }), /Item not found/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM brief_events').get()?.n, 1);
});
