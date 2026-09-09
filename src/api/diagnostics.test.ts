import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDatabase } from '../db/connection.js';
import { createReadingApi } from './server.js';

async function fixture(t: import('node:test').TestContext) {
  const db = openMemoryDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), 'reading-diagnostics-'));
  let providerCalls = 0;
  const server = createReadingApi({ host: '127.0.0.1', port: 0, dbPath: ':memory:', authToken: 'test-token',
    dataDir, backupDir: join(dataDir, 'backups'), flueModel: 'openai/test', flueTracePath: null }, db, {
    embedder: null, requestLogger: null, analyzer: async () => {
      providerCalls++;
      return { summary: 'A retained private proposition.', claims: [], relevance: { score: 0.8, themes: [] },
        recommended_action: 'save', confidence: 0.8, reason: 'Test fixture.', tags: [], relationships: [],
        model: 'test', analysis_version: 'old-version' };
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    db.close(); rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async (path: string, body?: unknown, token = 'test-token') => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, payload: await response.json() as any };
  };
  return { db, request, providerCalls: () => providerCalls };
}

test('authenticated diagnostics explain coverage without source data, mutations or provider calls', async t => {
  const { db, request, providerCalls } = await fixture(t);
  assert.equal((await request('/ingest', { request_id: randomUUID(), source_type: 'text',
    source: { text: 'A retained private proposition.' } })).status, 200);
  const before = db.prepare('SELECT total_changes() AS count').get()?.count;
  const result = await request('/diagnostics');
  assert.equal(result.status, 200);
  assert.equal(result.payload.data.analysis.stale_items, 1);
  assert.deepEqual(result.payload.data.analysis.stale_reason_counts,
    { missing_analysis: 0, version_mismatch: 1, model_mismatch: 0 });
  assert.equal(result.payload.data.graph.eligible_relationships, 0);
  assert.equal(result.payload.data.embeddings.enabled, false);
  assert.equal(providerCalls(), 1);
  assert.equal(db.prepare('SELECT total_changes() AS count').get()?.count, before);
  assert.doesNotMatch(JSON.stringify(result.payload), /retained private proposition|test-token|extracted_text|source_quote/);
  assert.equal((await request('/diagnostics', undefined, 'wrong')).status, 401);
  assert.equal((await request('/diagnostics?include=text')).status, 400);
  assert.equal((await request('/capabilities')).payload.data.supports_diagnostics, true);
});

test('diagnostics share the bounded query rate limit', async t => {
  const { request, providerCalls } = await fixture(t);
  for (let i = 0; i < 30; i++) assert.equal((await request('/diagnostics')).status, 200);
  assert.equal((await request('/diagnostics')).status, 429);
  assert.equal(providerCalls(), 0);
});
