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
  const get = async (path: string) => fetch(base + path, { headers: { authorization: 'Bearer test-token' } }).then(r => r.json()) as Promise<any>;
  return { db, post, get };
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
      return extractSource({ ...body, source_type: 'text', source: { type: 'text', text: 'Cache invalidation requires explicit dependencies.' } });
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
