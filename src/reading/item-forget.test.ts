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
import { briefGuide } from './brief-guide.js';

function fixture() {
  const db = openMemoryDatabase();
  const store = new ItemStore(db);
  const capture = async (text: string, uri?: string) => {
    const source = await extractSource({ request_id: randomUUID(), source_type: 'text', source: { text } });
    if (uri) source.sourceUri = uri;
    const input = { principal: 'local', requestId: randomUUID(), payloadHash: source.contentHash, source,
      analyze: async (itemId: string) => analyzeItem(db, { itemId, title: null, text }) };
    return { input, response: await store.ingest(input) };
  };
  return { db, store, capture };
}

test('forget cascades canonical content, removes retrieval, nulls supersedes and invalidates indirect snapshots', async () => {
  const { db, store, capture } = fixture();
  try {
    const first = await capture('Memory corpus evaluation analytics workflow privatewords.', 'https://example.com/story');
    const second = await capture('Memory corpus evaluation analytics workflow followup.', 'https://example.com/story');
    const itemId = first.response.item_id;
    const notes = new ReaderAnnotationStore(db);
    const noteBody = { request_id: randomUUID(), actor_type: 'user' as const, actor: 'reader', note: 'privatewords note' };
    const noteInput = { principal: 'local', requestId: noteBody.request_id, itemId, body: noteBody };
    const note = notes.record(noteInput);
    notes.record({ ...noteInput, requestId: randomUUID(), body: { ...noteBody, note: 'corrected privatewords', supersedes_annotation_id: note.annotation.id } });
    const events = new BriefEventStore(db);
    const eventBody = { request_id: randomUUID(), events: [itemId, second.response.item_id].map((item_id) => ({
      item_id, brief_date: new Date().toISOString().slice(0, 10), event_kind: 'skipped' as const,
      included_bool: false, rationale: 'privatewords rationale' })) };
    const eventInput = { principal: 'local', requestId: eventBody.request_id, payloadHash: briefEventsPayloadHash(eventBody), body: eventBody };
    events.record(eventInput);
    assert.ok((queryCorpus(db, { query: 'privatewords' }).citations as string[]).includes(itemId));
    assert.equal(store.forget({ itemId, principal: 'local' }).deleted, true);
    for (const table of ['analyses', 'tags', 'reader_annotations', 'brief_events', 'item_fts']) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE item_id = ?`).get(itemId)?.n, 0, table);
    }
    assert.equal(db.prepare('SELECT count(*) AS n FROM relationships WHERE from_item_id = ? OR to_item_id = ?').get(itemId, itemId)?.n, 0);
    assert.equal(db.prepare('SELECT supersedes_item_id FROM items WHERE id = ?').get(second.response.item_id)?.supersedes_item_id, null);
    assert.ok(!(queryCorpus(db, { query: 'privatewords' }).citations as string[]).includes(itemId));
    assert.ok(!JSON.stringify(briefGuide(db, { briefDate: new Date().toISOString().slice(0, 10) })).includes(itemId));
    for (const input of [first.input, second.input]) await assert.rejects(store.ingest(input), { code: 'ITEM_FORGOTTEN' });
    assert.throws(() => notes.record(noteInput), { code: 'ITEM_FORGOTTEN' });
    assert.throws(() => events.record(eventInput), { code: 'ITEM_FORGOTTEN' });
    const log = db.prepare("SELECT item_id, metadata_json FROM activity_log WHERE type = 'item.deleted'").get();
    assert.equal(log?.item_id, null);
    assert.deepEqual(JSON.parse(log?.metadata_json as string), { content_hash: first.response.content_hash });
    assert.doesNotMatch(JSON.stringify(db.prepare('SELECT response_snapshot FROM idempotency_keys').all()), /privatewords/);
    assert.throws(() => store.forget({ itemId, principal: 'local' }), { code: 'NOT_FOUND' });
    const recapture = await store.ingest({ ...first.input, requestId: randomUUID() });
    assert.notEqual(recapture.item_id, itemId);
    assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE type = 'ingest.previously_forgotten'").get());
  } finally { db.close(); }
});

test('forget rejects in-flight analysis and a stale late completion cannot recreate deleted content', async () => {
  const { db, store } = fixture();
  try {
    const source = await extractSource({ request_id: randomUUID(), source_type: 'text', source: { text: 'Memory must not resurrect deleted content.' } });
    let release!: () => void;
    const pending = store.ingest({ principal: 'local', requestId: randomUUID(), payloadHash: source.contentHash, source,
      analyze: async (itemId) => { await new Promise<void>((resolve) => { release = resolve; }); return analyzeItem(db, { itemId, title: null, text: source.extractedText }); } });
    await Promise.resolve();
    const itemId = db.prepare('SELECT id FROM items').get()?.id as string;
    assert.throws(() => store.forget({ itemId, principal: 'local' }), { code: 'ANALYSIS_IN_PROGRESS' });
    db.prepare('UPDATE items SET ingested_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', itemId);
    store.forget({ itemId, principal: 'local' });
    release();
    await assert.rejects(pending, { code: 'NOT_FOUND' });
    assert.equal(db.prepare('SELECT count(*) AS n FROM analyses').get()?.n, 0);
  } finally { db.close(); }
});

test('a capture that started before forgetting cannot resurrect content when extraction later completes', async () => {
  const { db, store, capture } = fixture();
  try {
    const first = await capture('Private memory must remain forgotten.');
    let release!: (source: typeof first.input.source) => void;
    const stalledRequestId = randomUUID();
    const pending = store.ingest({ principal: 'local', requestId: stalledRequestId, payloadHash: 'request-before-forget',
      extract: () => new Promise<typeof first.input.source>((resolve) => { release = resolve; }), analyze: first.input.analyze });
    await Promise.resolve();
    store.forget({ principal: 'local', itemId: first.response.item_id, requestId: 'private arbitrary header' });
    release(first.input.source);
    await assert.rejects(pending, { code: 'ITEM_FORGOTTEN' });
    assert.equal(db.prepare('SELECT count(*) AS n FROM items').get()?.n, 0);
    await assert.rejects(store.ingest({ ...first.input, requestId: stalledRequestId, payloadHash: 'request-before-forget' }), { code: 'ITEM_FORGOTTEN' });
    assert.equal(db.prepare("SELECT request_id FROM activity_log WHERE type = 'item.deleted'").get()?.request_id, null);
    assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM activity_log').all()), /private arbitrary header/);
    assert.equal((await store.ingest({ ...first.input, requestId: randomUUID() })).dedupe_status, 'created');
  } finally { db.close(); }
});
