import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDatabase } from '../db/connection.js';
import { createReadingApi } from './server.js';
import { ApiError } from './errors.js';

async function fixture(t: import('node:test').TestContext, options: { fail?: boolean } = {}) {
  const db = openMemoryDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), 'reading-diagnostics-'));
  let providerCalls = 0;
  const server = createReadingApi({ host: '127.0.0.1', port: 0, dbPath: ':memory:', authToken: 'test-token',
    dataDir, backupDir: join(dataDir, 'backups'), flueModel: 'openai/test', flueTracePath: null }, db, {
    embedder: null, requestLogger: null, analyzer: async () => {
      providerCalls++;
      if (options.fail) throw new ApiError('ANALYSIS_FAILED', 'private-provider-detail', 502, true);
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

test('failed-item HTTP inventory preserves privacy and validates authenticated bounded pagination', async t => {
  const { request, providerCalls } = await fixture(t, { fail: true });
  for (const text of ['First retained private proposition.', 'Second retained private proposition.']) {
    assert.equal((await request('/ingest', { request_id: randomUUID(), source_type: 'text', source: { text } })).status, 502);
  }
  const first = await request('/items?status=failed&limit=1');
  assert.equal(first.status, 200);
  assert.equal(first.payload.data.total, 2);
  assert.equal(first.payload.data.next_offset, 1);
  assert.equal(first.payload.data.items[0].retained_text, true);
  assert.equal(first.payload.data.items[0].latest_failure.code, 'ANALYSIS_FAILED');
  assert.equal(first.payload.data.items[0].retry_disposition, 'retryable');
  const second = await request('/items?status=failed&limit=1&offset=1');
  assert.equal(second.status, 200);
  assert.notEqual(first.payload.data.items[0].item_id, second.payload.data.items[0].item_id);
  assert.equal(second.payload.data.next_offset, null);
  assert.doesNotMatch(JSON.stringify([first.payload, second.payload]), /retained private proposition|private-provider-detail|test-token|extracted_text/);
  for (const query of ['status=failed&offset=-1', 'status=failed&offset=9007199254740992', 'status=failed&offset=',
    'status=failed&offset=1&offset=2', 'status=failed&limit=0', 'status=failed&limit=101',
    'status=failed&stale=true', 'status=failed&include=text', 'status=failed&status=failed', 'status=indexed']) {
    assert.equal((await request(`/items?${query}`)).status, 400, query);
  }
  assert.equal((await request('/items?status=failed', undefined, 'wrong')).status, 401);
  assert.equal((await request('/capabilities')).payload.data.supports_failed_items, true);
  assert.equal(providerCalls(), 2, 'listing never retries analysis');
});

test('diagnostics share the bounded query rate limit', async t => {
  const { request, providerCalls } = await fixture(t);
  for (let i = 0; i < 30; i++) assert.equal((await request('/diagnostics')).status, 200);
  assert.equal((await request('/diagnostics')).status, 429);
  assert.equal(providerCalls(), 0);
});
