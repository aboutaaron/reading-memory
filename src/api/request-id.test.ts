import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { openMemoryDatabase } from '../db/connection.js';
import { createReadingApi } from './server.js';

const requestId = '00000000-0000-4000-8000-000000000030';

async function api(t: TestContext) {
  const db = openMemoryDatabase();
  const server = createReadingApi({
    host: '127.0.0.1', port: 0, dbPath: ':memory:', authToken: 'secret',
    dataDir: tmpdir(), backupDir: tmpdir(), flueModel: 'test/model', flueTracePath: null
  }, db, { analyzer: async () => { throw new Error('Invalid input must not reach analysis'); } });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => {
      db.close();
      if (error) reject(error);
      else resolve();
    });
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return async (path: string, body: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json', ...headers }, body
    });
    return { status: response.status, body: await response.json() as { request_id: string | null; error: { code: string } } };
  };
}

test('echoes valid body request IDs when any POST route fails schema validation', async (t) => {
  const post = await api(t);
  for (const route of ['/ingest', '/query', '/brief-guide', '/brief-events', '/items/missing/annotations']) {
    const response = await post(route, JSON.stringify({ request_id: requestId }), { 'x-request-id': 'header-fallback' });
    assert.equal(response.status, 400, route);
    assert.equal(response.body.error.code, 'BAD_REQUEST', route);
    assert.equal(response.body.request_id, requestId, route);
  }
});

test('invalid, missing, and oversized body IDs retain the header fallback', async (t) => {
  const post = await api(t);
  for (const body of [
    {}, { request_id: 42 }, { request_id: null }, { request_id: 'not-a-uuid' },
    { request_id: 'x'.repeat(10_000) }, [requestId], null
  ]) {
    const response = await post('/query', JSON.stringify(body), { 'x-request-id': 'header-fallback' });
    assert.equal(response.status, 400);
    assert.equal(response.body.request_id, 'header-fallback');
  }
  const noHeader = await post('/query', JSON.stringify({ request_id: 'invalid' }));
  assert.equal(noHeader.body.request_id, null);
  const malformed = await post('/query', '{', { 'x-request-id': 'header-fallback' });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.request_id, 'header-fallback');
});

test('authentication rejects requests before inspecting the body ID', async (t) => {
  const post = await api(t);
  for (const body of [JSON.stringify({ request_id: requestId }), '{']) {
    const response = await post('/query', body, { authorization: 'Bearer wrong', 'x-request-id': 'header-fallback' });
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'UNAUTHORIZED');
    assert.equal(response.body.request_id, 'header-fallback');
  }
});
