import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openMemoryDatabase } from '../db/connection.js';
import { ItemStore } from './item-store.js';
import { ReaderAnnotationStore } from './reader-annotations.js';
import { BriefEventStore, briefEventsPayloadHash } from './brief-events.js';
import { extractSource } from './extract-source.js';
import { analyzeItem } from './analyzer.js';
import { queryCorpus } from './corpus-query.js';
import { analysisFreshness, listStaleItems } from './analysis-freshness.js';
import type { Analysis, ExtractedSource } from './types.js';

const newer: Analysis = { summary: 'New judgment about zebracontext.', reason: 'New interpretation.', claims: ['New claim'],
  relevance: { score: 0.8, themes: ['newtag'] }, recommended_action: 'brief', confidence: 0.8,
  tags: [{ tag: 'newtag', reason: 'new', confidence: 0.8 }], relationships: [], model: 'new-model', analysis_version: 'new-version' };

async function fixture() {
  const db = openMemoryDatabase();
  const store = new ItemStore(db);
  const text = 'Memory corpus evaluation analytics workflow original.';
  const source = await extractSource({ request_id: randomUUID(), source_type: 'text', source: { text },
    source_context: 'reading list', ingest_reason: 'Investigate dependencies' });
  const input = { principal: 'local', requestId: randomUUID(), payloadHash: source.contentHash, source,
    analyze: async (itemId: string) => analyzeItem(db, { itemId, title: null, text }) };
  const item = await store.ingest(input);
  return { db, store, itemId: item.item_id, input };
}

test('reanalysis retains identity, source, prior analyses, brief history and notes, replacing tags and current FTS atomically', async () => {
  const { db, store, itemId, input } = await fixture();
  try {
    const before = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
    const annotations = new ReaderAnnotationStore(db);
    annotations.record({ principal: 'local', requestId: randomUUID(), itemId,
      body: { request_id: randomUUID(), actor_type: 'user', actor: 'reader', note: 'durablenote' } });
    const body = { request_id: randomUUID(), events: [{ item_id: itemId, brief_date: '2026-09-09', event_kind: 'included' as const, included_bool: true, rationale: 'Keep history.' }] };
    new BriefEventStore(db).record({ principal: 'local', requestId: body.request_id, payloadHash: briefEventsPayloadHash(body), body });
    assert.equal(analysisFreshness(db, newer.analysis_version, newer.model).stale_items, 1);
    assert.equal(listStaleItems(db, newer.analysis_version, newer.model, 1).items[0]?.item_id, itemId);
    let analyzed = 0;
    const operation = { principal: 'local', requestId: randomUUID(), itemId, analyze: async (id: string, source: ExtractedSource) => {
      analyzed += 1; assert.equal(id, itemId); assert.deepEqual(source, input.source); return newer;
    } };
    const result = await store.reanalyze(operation);
    assert.equal(result.dedupe_status, 'reanalyzed');
    assert.equal(result.summary, newer.summary);
    assert.equal((await store.reanalyze(operation)).dedupe_status, 'idempotent_replay');
    assert.equal(analyzed, 1);
    assert.deepEqual(db.prepare('SELECT * FROM items WHERE id = ?').get(itemId), before);
    assert.equal(db.prepare('SELECT count(*) AS n FROM analyses WHERE item_id = ?').get(itemId)?.n, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM brief_events WHERE item_id = ?').get(itemId)?.n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM reader_annotations WHERE item_id = ?').get(itemId)?.n, 1);
    assert.deepEqual(db.prepare('SELECT tag FROM tags WHERE item_id = ?').all(itemId).map((r) => r.tag), ['newtag']);
    assert.deepEqual(queryCorpus(db, { query: 'zebracontext' }).citations, [itemId]);
    assert.deepEqual(queryCorpus(db, { query: 'durablenote' }).citations, [itemId]);
    assert.equal(analysisFreshness(db, newer.analysis_version, newer.model).stale_items, 0);
    assert.equal(analysisFreshness(db, newer.analysis_version, 'different-model').stale_items, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM analysis_jobs').get()?.n, 0);
  } finally { db.close(); }
});

test('reanalysis leaves indexed results available, rejects conflicting writes and protects the shared request namespace', async () => {
  const { db, store, itemId, input } = await fixture();
  try {
    let release!: (value: Analysis) => void;
    const requestId = randomUUID();
    const pending = store.reanalyze({ principal: 'local', requestId, itemId,
      analyze: () => new Promise<Analysis>((resolve) => { release = resolve; }) });
    assert.deepEqual(queryCorpus(db, { query: 'original' }).citations, [itemId]);
    for (const req of [requestId, randomUUID()]) {
      await assert.rejects(store.reanalyze({ principal: 'local', requestId: req, itemId, analyze: async () => newer }), { code: 'ANALYSIS_IN_PROGRESS' });
    }
    assert.throws(() => store.forget({ principal: 'local', itemId }), { code: 'ANALYSIS_IN_PROGRESS' });
    await assert.rejects(store.ingest({ ...input, requestId: randomUUID() }), { code: 'ANALYSIS_IN_PROGRESS' });
    let extracted = false;
    await assert.rejects(store.ingest({ principal: 'local', requestId, payloadHash: 'unrelated', extract: async () => { extracted = true; return input.source; }, analyze: async () => newer }), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal(extracted, false);
    assert.throws(() => new ReaderAnnotationStore(db).record({ principal: 'local', requestId, itemId,
      body: { request_id: requestId, actor_type: 'user', actor: 'reader', note: 'note' } }), { code: 'IDEMPOTENCY_CONFLICT' });
    release(newer); await pending;
    await assert.rejects(store.reanalyze({ principal: 'local', requestId, itemId: 'different', analyze: async () => newer }), { code: 'IDEMPOTENCY_CONFLICT' });
  } finally { db.close(); }
});

test('failed reanalysis rolls back replacement and releases its lease for the same request retry', async () => {
  const { db, store, itemId } = await fixture();
  try {
    const before = JSON.stringify(db.prepare('SELECT * FROM analyses').all());
    const tags = JSON.stringify(db.prepare('SELECT * FROM tags').all());
    const operation = { principal: 'local', requestId: randomUUID(), itemId };
    await assert.rejects(store.reanalyze({ ...operation, analyze: async () => ({ ...newer,
      relationships: [{ from_item_id: itemId, to_item_id: 'missing', relation_type: 'extends', confidence: 0.8, explanation: 'bad target' }] }) }), /FOREIGN KEY/);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM analyses').all()), before);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM tags').all()), tags);
    assert.equal(db.prepare('SELECT count(*) AS n FROM analysis_jobs').get()?.n, 0);
    assert.equal(db.prepare('SELECT status FROM items WHERE id = ?').get(itemId)?.status, 'indexed');
    assert.equal((await store.reanalyze({ ...operation, analyze: async () => newer })).dedupe_status, 'reanalyzed');
  } finally { db.close(); }
});

test('expired reanalysis cannot overwrite a newer success or resurrect a forgotten item', async () => {
  const { db, store, itemId } = await fixture();
  try {
    let release!: (value: Analysis) => void;
    const first = store.reanalyze({ principal: 'local', requestId: randomUUID(), itemId, analyze: () => new Promise<Analysis>((resolve) => { release = resolve; }) });
    db.prepare("UPDATE analysis_jobs SET expires_at = '2000-01-01'").run();
    await store.reanalyze({ principal: 'local', requestId: randomUUID(), itemId, analyze: async () => newer });
    release({ ...newer, summary: 'Late stale judgment' });
    await assert.rejects(first, { code: 'ANALYSIS_IN_PROGRESS' });
    assert.equal(db.prepare('SELECT count(*) AS n FROM analyses').get()?.n, 2);
    const next = store.reanalyze({ principal: 'local', requestId: randomUUID(), itemId, analyze: () => new Promise<Analysis>((resolve) => { release = resolve; }) });
    db.prepare("UPDATE analysis_jobs SET expires_at = '2000-01-01'").run();
    store.forget({ principal: 'local', itemId });
    release(newer);
    await assert.rejects(next, { code: 'NOT_FOUND' });
    assert.equal(db.prepare('SELECT count(*) AS n FROM analyses').get()?.n, 0);
  } finally { db.close(); }
});

test('reanalysis replaces its outgoing judgments and heuristics while preserving incoming source citations', async () => {
  const { db, store, itemId, input } = await fixture();
  try {
    const other = await store.ingest({ ...input, requestId: randomUUID(), source: { ...input.source, contentHash: 'another-content-hash' } });
    db.exec('DELETE FROM relationships');
    const insert = db.prepare(`INSERT INTO relationships
      (id, from_item_id, to_item_id, relation_type, explanation, confidence, created_at, origin)
      VALUES (?, ?, ?, ?, 'prior judgment', 0.8, '2026-01-01', ?)`);
    insert.run('outgoing', itemId, other.item_id, 'extends', 'model');
    insert.run('incoming', other.item_id, itemId, 'supports', 'model');
    insert.run('heuristic', itemId, other.item_id, 'same_theme', 'heuristic');
    await store.reanalyze({ principal: 'local', requestId: randomUUID(), itemId, analyze: async () => ({ ...newer,
      relationships: [{ from_item_id: itemId, to_item_id: other.item_id, relation_type: 'updates',
        explanation: 'Revised interpretation', confidence: 0.8, origin: 'model' }] }) });
    assert.deepEqual(db.prepare('SELECT relation_type FROM relationships ORDER BY relation_type').all().map((row) => row.relation_type), ['supports', 'updates']);
    assert.ok(db.prepare("SELECT 1 FROM relationships WHERE id = 'incoming'").get());
  } finally { db.close(); }
});


test('bare OpenAI model IDs and provider-prefixed IDs report the same analysis freshness', async () => {
  const { db, itemId } = await fixture();
  try {
    db.prepare('UPDATE analyses SET model = ?, analysis_version = ? WHERE item_id = ?')
      .run('openai/gpt-5.6-luna', 'current', itemId);
    assert.equal(analysisFreshness(db, 'current', 'gpt-5.6-luna').stale_items, 0);
    assert.equal(analysisFreshness(db, 'current', 'openai/gpt-5.6-luna').stale_items, 0);
    assert.equal(analysisFreshness(db, 'current', 'anthropic/gpt-5.6-luna').stale_items, 1);
    assert.deepEqual(listStaleItems(db, 'current', 'gpt-5.6-luna', 10).items, []);
    db.prepare('UPDATE analyses SET model = ? WHERE item_id = ?').run('gpt-5.6-luna', itemId);
    assert.equal(analysisFreshness(db, 'current', 'openai/gpt-5.6-luna').stale_items, 0);
  } finally { db.close(); }
});
