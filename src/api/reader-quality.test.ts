import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMemoryDatabase } from '../db/connection.js';
import { createReadingApi } from './server.js';
import { extractSource } from '../reading/extract-source.js';
import type { ReadingAnalyzer } from '../reading/flue-agent.js';
import { LIMITS } from '../config.js';

const analysis = {
  summary: 'Cache invalidation requires explicit dependencies.', claims: ['Cache dependencies matter.'],
  relevance: { score: 0.9, themes: ['evaluation'] }, recommended_action: 'brief' as const,
  confidence: 0.8, reason: 'Useful for validating changes to the analytics harness.',
  tags: [], relationships: [], model: 'test', analysis_version: 'test'
};

async function fixture(t: import('node:test').TestContext, options: Parameters<typeof createReadingApi>[2] = {}) {
  const db = openMemoryDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), 'reading-quality-'));
  const server = createReadingApi({ host: '127.0.0.1', port: 0, dbPath: ':memory:', authToken: 'test-token', dataDir,
    backupDir: join(dataDir, 'backups'), flueModel: 'test', flueTracePath: null }, db,
    { analyzer: async () => analysis, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close(); rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (path: string, body: unknown, token = 'test-token') => {
    const response = await fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${token}`,
      'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, payload: await response.json() as any };
  };
  const getResponse = async (path: string, token: string | null = 'test-token') => {
    const response = await fetch(base + path, { headers: token === null ? {} : { authorization: `Bearer ${token}` } });
    return { status: response.status, payload: await response.json() as any };
  };
  const get = async (path: string) => (await getResponse(path)).payload;
  return { db, post, get, getResponse };
}

const textRequest = () => ({ request_id: randomUUID(), source_type: 'text', source: { text: 'Cache invalidation requires explicit dependencies.' },
  source_context: 'project reading', ingest_reason: 'Evaluate stale evidence for the analytics harness.' });

test('reader annotations preserve attributed words and correction history through authenticated API', async (t) => {
  const { post, get } = await fixture(t);
  const ingest = await post('/ingest', textRequest());
  assert.equal(ingest.status, 200);
  const id = ingest.payload.data.item_id;
  const note = '  I disagree with using this beyond controlled data.\nKeep the caveat.  ';
  const body = { request_id: randomUUID(), actor_type: 'user', actor: 'Aaron', note,
    project: 'Analytics harness', question: 'How should messy contracts affect verification?' };
  assert.equal((await post(`/items/${id}/annotations`, body, 'wrong')).status, 401);
  const created = await post(`/items/${id}/annotations`, body);
  assert.equal(created.status, 200);
  assert.equal(created.payload.data.annotation.note, note);
  const replay = await post(`/items/${id}/annotations`, body);
  assert.equal(replay.payload.data.dedupe_status, 'idempotent_replay');
  assert.equal((await post(`/items/${id}/annotations`, { ...body, note: 'Changed payload' })).status, 409);
  assert.equal((await post(`/items/${id}/annotations`, { ...body, request_id: randomUUID(), note: ' ' })).status, 400);
  assert.equal((await post('/items/missing/annotations', { ...body, request_id: randomUUID() })).status, 404);
  const correction = await post(`/items/${id}/annotations`, { ...body, request_id: randomUUID(),
    note: 'I now think it applies if contract exceptions are explicit.', supersedes_annotation_id: created.payload.data.annotation.id });
  assert.equal(correction.status, 200);
  const item = (await get(`/items/${id}`)).data;
  assert.equal(item.analysis.reason, analysis.reason);
  assert.equal(item.reader_annotations.length, 2);
  assert.equal(item.reader_annotations.find((a: any) => a.id === created.payload.data.annotation.id).active, false);
  assert.equal(item.reader_annotations.find((a: any) => a.active).note, correction.payload.data.annotation.note);
  assert.equal(item.provenance.ingest_reason, 'Evaluate stale evidence for the analytics harness.');
  const query = await post('/query', { request_id: randomUUID(), query: 'contract exceptions' });
  assert.deepEqual(query.payload.data.citations, [id]);
  const log = JSON.stringify(await get('/activity'));
  assert.doesNotMatch(log, /controlled data|messy contracts|Aaron|Keep the caveat/);
});

test('ingest replays and conflicts bypass unavailable URL extraction and preserve reader context', async (t) => {
  let calls = 0;
  let observed: Parameters<ReadingAnalyzer>[0]['readerContext'];
  const { post } = await fixture(t, {
    extractor: async (body) => {
      calls += 1;
      if (calls > 1) throw new Error('remote source unavailable');
      return extractSource({ ...body, source_type: 'text', source: { text: 'Cache invalidation requires explicit dependencies.' } });
    },
    analyzer: async ({ readerContext }) => { observed = readerContext; return analysis; }
  });
  const body = { ...textRequest(), source_type: 'url', source: { url: 'https://example.com/reading' } };
  assert.equal((await post('/ingest', body)).status, 200);
  assert.equal((await post('/ingest', body)).payload.data.dedupe_status, 'idempotent_replay');
  assert.equal((await post('/ingest', { ...body, ingest_reason: 'another reason' })).status, 409);
  assert.equal(calls, 1);
  assert.equal(observed?.ingest_reason, body.ingest_reason);
});

test('rejects impossible brief dates and overlong reader context before invoking analysis', async (t) => {
  const { post } = await fixture(t);
  assert.equal((await post('/brief-guide', { request_id: randomUUID(), brief_date: '2026-02-30' })).status, 400);
  assert.equal((await post('/ingest', { ...textRequest(), ingest_reason: 'x'.repeat(4001) })).status, 400);
});

test('legacy ingest type replays through the sole discriminator and mismatches fail before extraction', async (t) => {
  let extractions = 0;
  const { post } = await fixture(t, {
    extractor: async (body) => {
      extractions += 1;
      assert.equal('type' in body.source, false);
      return extractSource(body);
    }
  });
  const request = textRequest();
  const legacy = { ...request, source: { ...request.source, type: 'text' } };
  assert.equal((await post('/ingest', legacy)).status, 200);
  assert.equal((await post('/ingest', request)).payload.data.dedupe_status, 'idempotent_replay');
  assert.equal((await post('/ingest', { ...legacy, source: { ...legacy.source, type: 'url' } })).status, 400);
  assert.equal(extractions, 1);
});

test('item details omit source text by default and opt-in returns exactly the stored text with evidence and truncation', async (t) => {
  const { db, post, getResponse } = await fixture(t);
  const first = await post('/ingest', textRequest());
  const second = await post('/ingest', { ...textRequest(), source: { text: 'Cache invalidation requires ownership.' } });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const id = first.payload.data.item_id;
  const otherId = second.payload.data.item_id;
  const evidence = { source_quote: 'Cache invalidation requires explicit dependencies.', target_quote: 'Cache invalidation requires ownership.' };
  db.prepare(`INSERT INTO relationships (id, from_item_id, to_item_id, relation_type, explanation, confidence, created_at, origin, evidence_json)
    VALUES (?, ?, ?, 'extends', 'Adds ownership to the dependency requirement.', 0.8, ?, 'model', ?)`)
    .run(randomUUID(), id, otherId, new Date().toISOString(), JSON.stringify(evidence));

  const defaultResponse = await getResponse(`/items/${id}`);
  assert.equal(defaultResponse.status, 200);
  const item = defaultResponse.payload.data;
  assert.equal(Object.hasOwn(item, 'extracted_text'), false);
  assert.equal(item.truncated, false);
  assert.equal(item.analysis.reason, analysis.reason);
  assert.deepEqual(item.relationships.find((relationship: any) => relationship.origin === 'model').evidence, evidence);
  const expanded = await getResponse(`/items/${id}?include=text`);
  assert.equal(expanded.status, 200);
  assert.equal(expanded.payload.data.extracted_text, textRequest().source.text);
  const { extracted_text: omitted, ...expandedMetadata } = expanded.payload.data;
  assert.deepEqual(expandedMetadata, item);

  // Simulate the stored, capped result of a longer URL or PDF extraction. A
  // detail request must neither silently expand nor truncate this stored text.
  const storedText = ('Cache invalidation requires explicit dependencies.\n' + 'Additional context.\n'.repeat(6000)).slice(0, LIMITS.maxTextChars);
  db.prepare('UPDATE items SET extracted_text = ?, truncated = 1 WHERE id = ?').run(storedText, id);
  const truncatedDefault = await getResponse(`/items/${id}`);
  assert.equal(truncatedDefault.payload.data.truncated, true);
  assert.equal(Object.hasOwn(truncatedDefault.payload.data, 'extracted_text'), false);
  const truncatedExpanded = await getResponse(`/items/${id}?include=text`);
  assert.equal(truncatedExpanded.payload.data.truncated, true);
  assert.equal(truncatedExpanded.payload.data.extracted_text, storedText);
  assert.equal(truncatedExpanded.payload.data.extracted_text.length, LIMITS.maxTextChars);
});

test('item text expansion requires authentication and rejects invalid include options', async (t) => {
  const { post, getResponse } = await fixture(t);
  const ingest = await post('/ingest', textRequest());
  const id = ingest.payload.data.item_id;
  for (const path of [`/items/${id}`, `/items/${id}?include=text`]) {
    assert.equal((await getResponse(path, null)).status, 401);
    assert.equal((await getResponse(path, 'wrong')).status, 401);
  }
  for (const include of ['', 'all', 'text,analysis', 'text&include=text']) {
    const response = await getResponse(`/items/${id}?include=${include}`);
    assert.equal(response.status, 400);
    assert.equal(response.payload.error.code, 'BAD_REQUEST');
  }
  assert.equal((await getResponse('/items/missing?include=text')).status, 404);
});

test('annotation rate limit allows thirty writes without consuming the ingest quota', async (t) => {
  const { post, get } = await fixture(t);
  const ingest = await post('/ingest', textRequest());
  const id = ingest.payload.data.item_id;
  const note = () => ({ request_id: randomUUID(), actor_type: 'user', actor: 'Aaron', note: 'Useful context.' });
  for (let i = 0; i < 30; i += 1) {
    assert.equal((await post(`/items/${id}/annotations`, note())).status, 200, `annotation ${i + 1}`);
  }
  const limited = await post(`/items/${id}/annotations`, note());
  assert.equal(limited.status, 429);
  assert.equal(limited.payload.error.code, 'RATE_LIMITED');
  assert.ok(limited.payload.error.retry_after_seconds > 0);
  for (let i = 1; i < 10; i += 1) {
    assert.equal((await post('/ingest', textRequest())).status, 200, `ingest ${i + 1}`);
  }
  assert.equal((await post('/ingest', textRequest())).status, 429);
  const capabilities = (await get('/capabilities')).data;
  assert.equal(capabilities.rate_limits.annotation_per_minute, 30);
  assert.equal(capabilities.rate_limits.ingest_per_minute, 10);
});

test('exhausted ingest quota does not block reader annotations', async (t) => {
  const { post } = await fixture(t);
  let id = '';
  for (let i = 0; i < 10; i += 1) {
    const ingest = await post('/ingest', textRequest());
    assert.equal(ingest.status, 200);
    id = ingest.payload.data.item_id;
  }
  assert.equal((await post('/ingest', textRequest())).status, 429);
  const annotation = await post(`/items/${id}/annotations`, {
    request_id: randomUUID(), actor_type: 'user', actor: 'Aaron', note: 'Annotations remain available during heavy ingestion.'
  });
  assert.equal(annotation.status, 200);
});


test('HTTP supports explicit usage mode and cited events while rejecting incompatible citation fields', async (t) => {
  const { post, get } = await fixture(t);
  const ingest = await post('/ingest', textRequest());
  const itemId = ingest.payload.data.item_id;
  const today = new Date().toISOString().slice(0, 10);
  const cited = { request_id: randomUUID(), events: [{ item_id: itemId, brief_date: today, event_kind: 'cited',
    included_bool: true, rationale: 'Used to explain dependency invalidation.', source_context: 'answer:quality-test' }] };
  assert.equal((await post('/brief-events', cited, 'wrong')).status, 401);
  const created = await post('/brief-events', cited);
  assert.equal(created.status, 200); assert.equal(created.payload.data.events[0].event_kind, 'cited');
  assert.equal((await post('/brief-events', cited)).payload.data.dedupe_status, 'idempotent_replay');
  const item = (await get(`/items/${itemId}`)).data;
  assert.equal(item.usage_count, 1);
  assert.equal(item.last_used_at, created.payload.data.events[0].created_at);
  const query = await post('/query', { request_id: randomUUID(), query: 'cache invalidation', mode: 'fts+usage' });
  assert.equal(query.status, 200); assert.equal(query.payload.data.retrieval_mode, 'fts+usage');
  assert.equal(query.payload.data.results[0].usage.usage_count, 1);
  const caps = (await get('/capabilities')).data;
  assert.ok(caps.query_modes.includes('fts+usage')); assert.ok(caps.brief_event_kinds.includes('cited'));
  assert.equal((await post('/query', { request_id: randomUUID(), query: 'cache', mode: 'unknown' })).status, 400);
  for (const patch of [{ included_bool: false }, { resurface_after: today }, { event_kind: 'retrieved' }]) {
    assert.equal((await post('/brief-events', { request_id: randomUUID(), events: [{ ...cited.events[0], ...patch }] })).status, 400);
  }
});


test('HTTP citations require an answer context and count distinct answers without duplicate retries', async t => {
  const { db, post, get } = await fixture(t);
  const ingest = await post('/ingest', textRequest());
  const itemId = ingest.payload.data.item_id;
  const today = new Date().toISOString().slice(0, 10);
  const event = { item_id: itemId, brief_date: today, event_kind: 'cited', included_bool: true,
    rationale: 'Supports the answer about cache ownership.' };
  for (const sourceContext of [undefined, '', ' \t\n', '\u00a0']) {
    const requestId = randomUUID();
    const response = await post('/brief-events', { request_id: requestId,
      events: [{ ...event, ...(sourceContext === undefined ? {} : { source_context: sourceContext }) }] });
    assert.equal(response.status, 400);
    assert.equal(response.payload.error.code, 'BAD_REQUEST');
    assert.equal(db.prepare('SELECT 1 FROM idempotency_keys WHERE request_id = ?').get(requestId), undefined);
  }
  assert.equal((await get(`/items/${itemId}`)).data.usage_count, 0);
  const first = { request_id: randomUUID(), events: [{ ...event, source_context: 'answer:first' }] };
  const firstResponse = await post('/brief-events', first);
  assert.equal(firstResponse.status, 200);
  assert.equal(firstResponse.payload.data.dedupe_status, 'created');
  const second = await post('/brief-events', { request_id: randomUUID(),
    events: [{ ...event, source_context: 'answer:second' }] });
  assert.equal(second.status, 200);
  assert.notEqual(second.payload.data.events[0].id, firstResponse.payload.data.events[0].id);
  assert.equal((await post('/brief-events', first)).payload.data.dedupe_status, 'idempotent_replay');
  const duplicate = await post('/brief-events', { ...first, request_id: randomUUID() });
  assert.equal(duplicate.payload.data.dedupe_status, 'existing');
  assert.equal(duplicate.payload.data.events[0].id, firstResponse.payload.data.events[0].id);
  assert.equal((await get(`/items/${itemId}`)).data.usage_count, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM brief_events WHERE event_kind = 'cited'").get()?.n, 2);
});

test('HTTP legacy brief events retain optional or blank source contexts', async t => {
  const { post } = await fixture(t);
  const ingest = await post('/ingest', textRequest());
  const itemId = ingest.payload.data.item_id;
  for (const eventKind of ['included', 'skipped', 'resurfaced']) {
    for (const sourceContext of [undefined, '']) {
      const response = await post('/brief-events', { request_id: randomUUID(), events: [{
        item_id: itemId, brief_date: '2026-09-09', event_kind: eventKind,
        included_bool: eventKind !== 'skipped', rationale: 'Finalized brief outcome.',
        ...(sourceContext === undefined ? {} : { source_context: sourceContext })
      }] });
      assert.equal(response.status, 200);
      assert.equal(response.payload.data.events[0].source_context, '');
      assert.equal(response.payload.data.dedupe_status, sourceContext === undefined ? 'created' : 'existing');
    }
  }
});
