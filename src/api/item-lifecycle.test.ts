import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMemoryDatabase } from '../db/connection.js';
import { createReadingApi } from './server.js';

async function fixture(t: import('node:test').TestContext, options: Parameters<typeof createReadingApi>[2] = {}) {
  const db = openMemoryDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), 'reading-lifecycle-'));
  const server = createReadingApi({ host: '127.0.0.1', port: 0, dbPath: ':memory:', authToken: 'test-token', dataDir,
    backupDir: join(dataDir, 'backups'), flueModel: 'test', flueTracePath: null }, db,
    { analyzer: async () => ({ summary: 'Cache dependencies matter.', claims: [], relevance: { score: 0.8, themes: [] },
      recommended_action: 'brief', confidence: 0.8, reason: 'Useful.', tags: [], relationships: [], model: 'test', analysis_version: 'test' }), ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close(); rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async (method: string, path: string, body?: unknown, token = 'test-token', requestId?: string) => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(requestId ? { 'x-request-id': requestId } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, payload: await response.json() as any };
  };
  return { db, request };
}

test('forget API requires auth, advertises capability, rejects reason text and shares ingest rate limit', async (t) => {
  const { request } = await fixture(t);
  const body = { request_id: randomUUID(), source_type: 'text', source: { text: 'Cache dependencies matter.' } };
  const item = await request('POST', '/ingest', body);
  const path = `/items/${item.payload.data.item_id}`;
  assert.equal((await request('GET', '/capabilities')).payload.data.supports_forget, true);
  assert.equal((await request('DELETE', path, undefined, 'wrong')).status, 401);
  assert.equal((await request('DELETE', `${path}?reason=private`)).status, 400);
  assert.equal((await request('DELETE', path, undefined, 'test-token', 'private header text')).status, 200);
  assert.equal((await request('GET', `${path}?include=text`)).status, 404);
  assert.equal((await request('POST', '/ingest', body)).payload.error.code, 'ITEM_FORGOTTEN');
  for (let i = 0; i < 6; i += 1) assert.equal((await request('DELETE', path)).status, 404);
  assert.equal((await request('DELETE', path)).status, 429);
  assert.doesNotMatch(JSON.stringify((await request('GET', '/activity')).payload), /private/);
});

test('reanalysis API uses stored source and reader context, validates input and reports current model/version staleness', async (t) => {
  const { READING_ANALYSIS_VERSION } = await import('../reading/flue-agent.js');
  const { extractSource } = await import('../reading/extract-source.js');
  let analyses = 0;
  let extractions = 0;
  let seenContext: unknown;
  const { db, request } = await fixture(t, {
    extractor: async (input) => { extractions += 1; if (extractions > 1) throw new Error('Remote source no longer available'); return extractSource(input); },
    analyzer: async (input) => { analyses += 1; seenContext = input.readerContext; return {
      summary: analyses === 1 ? 'Original summary.' : 'Updated summary.', claims: [], relevance: { score: 0.8, themes: [] },
      recommended_action: 'brief', confidence: 0.8, reason: 'Useful.', tags: [], relationships: [], model: 'test',
      analysis_version: analyses === 1 ? 'old-version' : READING_ANALYSIS_VERSION
    }; }
  });
  const source = { request_id: randomUUID(), source_type: 'text', source: { text: 'Cache dependencies matter.' },
    source_context: 'reading list', ingest_reason: 'Update my understanding' };
  const item = await request('POST', '/ingest', source);
  const id = item.payload.data.item_id;
  assert.equal((await request('GET', '/health')).payload.data.analysis.stale_items, 1);
  const stale = await request('GET', '/items?stale=true&limit=1');
  assert.equal(stale.status, 200);
  assert.equal(stale.payload.data.items[0].item_id, id);
  assert.equal(Object.hasOwn(stale.payload.data.items[0], 'extracted_text'), false);
  assert.equal((await request('GET', '/items?stale=true', undefined, 'wrong')).status, 401);
  assert.equal((await request('GET', '/items?stale=false')).status, 400);
  assert.equal((await request('GET', '/items?stale=true&limit=101')).status, 400);
  const body = { request_id: randomUUID() };
  const path = `/items/${id}/reanalyze`;
  assert.equal((await request('POST', path, body, 'wrong')).status, 401);
  assert.equal((await request('POST', path, { request_id: 'invalid' })).status, 400);
  assert.equal((await request('POST', path, { ...body, force: true })).status, 400);
  const result = await request('POST', path, body);
  assert.equal(result.status, 200);
  assert.equal(result.payload.data.dedupe_status, 'reanalyzed');
  assert.equal(result.payload.data.summary, 'Updated summary.');
  assert.equal((await request('POST', path, body)).payload.data.dedupe_status, 'idempotent_replay');
  assert.equal(extractions, 1);
  assert.equal(analyses, 2);
  assert.deepEqual(seenContext, { source_context: source.source_context, ingest_reason: source.ingest_reason });
  assert.equal((await request('GET', '/health')).payload.data.analysis.stale_items, 0);
  assert.deepEqual((await request('GET', '/items?stale=true')).payload.data.items, []);
  assert.equal(db.prepare('SELECT count(*) AS n FROM analyses').get()?.n, 2);
  assert.equal((await request('POST', '/items/missing/reanalyze', { request_id: randomUUID() })).status, 404);
});
