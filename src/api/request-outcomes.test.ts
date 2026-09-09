import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { openMemoryDatabase } from '../db/connection.js';
import { createReadingApi } from './server.js';
import { ApiError } from './errors.js';
import { loadConfig } from '../config.js';
import { requestRoute, type RequestOutcome } from './request-outcomes.js';

async function fixture(logger: ((event: RequestOutcome) => void) | null, token = 'PRIVATE_BEARER') {
  const db = openMemoryDatabase(); const directory = mkdtempSync(join(tmpdir(), 'reading-outcomes-'));
  const server = createReadingApi({ host: '127.0.0.1', port: 0, dbPath: ':memory:', authToken: token,
    dataDir: directory, backupDir: directory, flueModel: 'test/model', flueTracePath: null }, db, {
    requestLogger: logger,
    analyzer: async () => { throw new ApiError('PRIVATE_ERROR_CODE' as never, 'PRIVATE_ERROR_MESSAGE', 502); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return { server, base: `http://127.0.0.1:${address.port}`, async close() {
    server.close(); await once(server, 'close'); db.close(); rmSync(directory, { recursive: true, force: true });
  } };
}

test('completed success and failure outcomes contain only normalized metadata, never request or error content', async () => {
  const events: RequestOutcome[] = []; const app = await fixture((event) => events.push(event));
  const auth = { authorization: 'Bearer PRIVATE_BEARER', 'x-request-id': 'PRIVATE_HEADER', 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(`${app.base}/health?PRIVATE_QUERY=secret`)).status, 200);
    assert.equal((await fetch(`${app.base}/items/PRIVATE_ITEM?note=PRIVATE_URL`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${app.base}/PRIVATE_PATH`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${app.base}/query`, { method: 'POST', headers: auth,
      body: JSON.stringify({ query: 'PRIVATE_QUERY_BODY' }) })).status, 400);
    assert.equal((await fetch(`${app.base}/ingest`, { method: 'POST', headers: auth, body: JSON.stringify({
      request_id: '00000000-0000-4000-8000-000000000001', source_type: 'text',
      source: { text: 'PRIVATE_BODY To: PRIVATE_EMAIL@example.com', title: 'PRIVATE_TITLE' }
    }) })).status, 502);
    assert.equal((await fetch(`${app.base}/capabilities`, { headers: { authorization: 'Bearer PRIVATE_WRONG_KEY' } })).status, 401);
    assert.equal(events.length, 6);
    assert.deepEqual(events.map((event) => event.route), ['/health', '/items/:itemId', 'unmatched', '/query', '/ingest', '/capabilities']);
    assert.deepEqual(events.map((event) => event.status), [200, 404, 404, 400, 502, 401]);
    assert.deepEqual(events.map((event) => event.error_code), [null, 'NOT_FOUND', 'NOT_FOUND', 'BAD_REQUEST', 'INTERNAL_ERROR', 'UNAUTHORIZED']);
    assert(!JSON.stringify(events).includes('PRIVATE'));
    for (const event of events) {
      assert.deepEqual(Object.keys(event).sort(), ['duration_ms', 'error_code', 'event', 'method', 'route', 'status']);
      assert(Number.isFinite(event.duration_ms) && event.duration_ms >= 0);
    }
  } finally { await app.close(); }
});

test('unknown HTTP methods and routes are normalized; no raw item IDs are logged', async () => {
  const events: RequestOutcome[] = []; const app = await fixture((event) => events.push(event));
  try {
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(`${app.base}/items/PRIVATE_ID/annotations?PRIVATE_QUERY`, {
        method: 'PROPFIND', headers: { authorization: 'Bearer PRIVATE_BEARER' }
      }, (response) => { response.resume(); response.on('end', resolve); });
      request.on('error', reject); request.end();
    });
    assert.equal(events[0]!.method, 'OTHER');
    assert.equal(events[0]!.route, '/items/:itemId/annotations');
    assert.equal(requestRoute('/items/PRIVATE/extra/PRIVATE'), 'unmatched');
    assert.equal(requestRoute('/items/PRIVATE/reanalyze'), '/items/:itemId/reanalyze');
    assert.equal(requestRoute('/items'), '/items');
    assert(!JSON.stringify(events).includes('PRIVATE'));
  } finally { await app.close(); }
});

test('health remains unauthenticated while other routes require auth and non-loopback host headers fail', async () => {
  const events: RequestOutcome[] = []; const app = await fixture((event) => events.push(event), '');
  try {
    assert.equal((await fetch(`${app.base}/health`)).status, 200);
    assert.equal((await fetch(`${app.base}/capabilities`)).status, 503);
    const badHostStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${app.base}/health`, { headers: { host: 'PRIVATE_EXTERNAL_HOST.example' } },
        (response) => { response.resume(); response.on('end', () => resolve(response.statusCode!)); });
      request.on('error', reject); request.end();
    });
    assert.equal(badHostStatus, 400);
    assert.equal(events[2]!.route, 'unmatched');
    assert(!JSON.stringify(events).includes('PRIVATE'));
    assert.throws(() => loadConfig({ READING_API_HOST: '0.0.0.0' }), /loopback-only/);
  } finally { await app.close(); }
});

test('disabled, throwing, and asynchronously rejecting request loggers do not change response behavior', async () => {
  for (const logger of [null, () => { throw new Error('PRIVATE_LOGGER_ERROR'); },
    async () => { throw new Error('PRIVATE_ASYNC_LOGGER_ERROR'); }]) {
    const app = await fixture(logger);
    try {
      assert.equal((await fetch(`${app.base}/health`)).status, 200);
      // Allow a rejected async logger to reach the unhandled-rejection turn.
      // node:test fails this test if the observer fails to consume it.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    finally { await app.close(); }
  }
});
