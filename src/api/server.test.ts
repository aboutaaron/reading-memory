import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDatabase } from '../db/connection.js';
import { createReadingApi } from './server.js';
import { analyzeItem } from '../reading/analyzer.js';
import type { AppConfig } from '../config.js';

function testConfig(dataDir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dbPath: ':memory:',
    authToken: 'secret',
    dataDir,
    backupDir: join(dataDir, 'backups'),
    flueModel: 'test/model',
    flueTracePath: null,
    ...overrides
  };
}

test('ingests text, queries it, and exposes item detail without logging raw text', async () => {
  const db = openMemoryDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), 'reading-api-test-'));
  const server = createReadingApi(testConfig(dataDir), db, {
    analyzer: async ({ itemId, title, text }) => analyzeItem(db, { itemId, title, text })
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.equal(typeof address, 'object');
  const base = `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`;

  const ingest = await fetch(`${base}/ingest`, {
    method: 'POST',
    headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      request_id: '00000000-0000-4000-8000-000000000001',
      source_type: 'text',
      source: {
        text: 'To: aaron@example.com\n\nAgent memory and semantic analytics need durable evaluation.',
        title: 'Memory note'
      }
    })
  }).then((res) => res.json() as Promise<any>);

  assert.equal(ingest.ok, true);
  assert.equal(ingest.data.dedupe_status, 'created');

  const query = await fetch(`${base}/query`, {
    method: 'POST',
    headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      request_id: '00000000-0000-4000-8000-000000000002',
      query: 'agent memory',
      top_k: 5
    })
  }).then((res) => res.json() as Promise<any>);

  assert.equal(query.ok, true);
  assert.ok(query.data.answer.includes(`[${ingest.data.item_id}]`));
  assert.deepEqual(query.data.citations, [ingest.data.item_id]);

  const emptyQuery = await fetch(`${base}/query`, {
    method: 'POST',
    headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      request_id: '00000000-0000-4000-8000-000000000004',
      query: '--- !!!',
      top_k: 5
    })
  }).then((res) => res.json() as Promise<any>);

  assert.equal(emptyQuery.ok, true);
  assert.deepEqual(emptyQuery.data.results, []);
  assert.equal(emptyQuery.data.confidence, 0);
  assert.equal(emptyQuery.data.empty_reason, 'No searchable reading-corpus terms found.');

  const activity = await fetch(`${base}/activity`, {
    headers: { authorization: 'Bearer secret' }
  }).then((res) => res.text());
  assert.doesNotMatch(activity, /aaron@example\.com/);
  assert.doesNotMatch(activity, /semantic analytics need durable/);

  const brief = await fetch(`${base}/brief-guide`, {
    method: 'POST',
    headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      request_id: '00000000-0000-4000-8000-000000000003',
      brief_date: '2026-05-04',
      lookback_hours: 1,
      focus: ['agent-memory']
    })
  }).then((res) => res.json() as Promise<any>);
  assert.equal(brief.ok, true);
  assert.equal(brief.data.candidates[0].item_id, ingest.data.item_id);

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('rejects unauthenticated capability access', async () => {
  const db = openMemoryDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), 'reading-api-test-'));
  const server = createReadingApi(testConfig(dataDir), db);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const base = `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`;

  const res = await fetch(`${base}/capabilities`);
  assert.equal(res.status, 401);

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('health reports backup status as missing when backup dir is absent', async () => {
  const db = openMemoryDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), 'reading-api-test-'));
  const server = createReadingApi(testConfig(dataDir), db);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;

  const res = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json() as Promise<any>);
  assert.equal(res.data.backup.status, 'missing');
  assert.equal(res.data.backup.warn, false);
  assert.equal(res.data.backup.last_backup_at, undefined);

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('health reports backup status as ok when a recent backup exists', async () => {
  const db = openMemoryDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), 'reading-api-test-'));
  const backupDir = join(dataDir, 'backups');
  mkdirSync(backupDir, { recursive: true });
  const backupFile = join(backupDir, 'reading-20260508T032000Z.sqlite');
  writeFileSync(backupFile, '');
  const now = Date.now() / 1000;
  utimesSync(backupFile, now, now);

  const server = createReadingApi(testConfig(dataDir, { backupDir }), db);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;

  const res = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json() as Promise<any>);
  assert.equal(res.data.backup.status, 'ok');
  assert.equal(res.data.backup.warn, false);
  assert.equal(typeof res.data.backup.last_backup_at, 'string');
  assert.ok(res.data.backup.age_seconds >= 0 && res.data.backup.age_seconds < 60);

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('health reports backup status as stale when newest backup exceeds threshold', async () => {
  const db = openMemoryDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), 'reading-api-test-'));
  const backupDir = join(dataDir, 'backups');
  mkdirSync(backupDir, { recursive: true });
  const backupFile = join(backupDir, 'reading-20260507T032000Z.sqlite');
  writeFileSync(backupFile, '');
  const thirtyHoursAgo = (Date.now() - 30 * 60 * 60 * 1000) / 1000;
  utimesSync(backupFile, thirtyHoursAgo, thirtyHoursAgo);

  const server = createReadingApi(testConfig(dataDir, { backupDir }), db);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;

  const res = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json() as Promise<any>);
  assert.equal(res.data.backup.status, 'stale');
  assert.equal(res.data.backup.warn, true);
  assert.ok(res.data.backup.age_seconds >= 30 * 60 * 60);

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('health picks the newest backup file when several exist', async () => {
  const db = openMemoryDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), 'reading-api-test-'));
  const backupDir = join(dataDir, 'backups');
  mkdirSync(backupDir, { recursive: true });

  const oldFile = join(backupDir, 'reading-20260501T032000Z.sqlite');
  const recentFile = join(backupDir, 'reading-20260508T032000Z.sqlite');
  writeFileSync(oldFile, '');
  writeFileSync(recentFile, '');

  const longAgo = (Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000;
  const now = Date.now() / 1000;
  utimesSync(oldFile, longAgo, longAgo);
  utimesSync(recentFile, now, now);

  const server = createReadingApi(testConfig(dataDir, { backupDir }), db);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;

  const res = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json() as Promise<any>);
  assert.equal(res.data.backup.status, 'ok');
  assert.ok(res.data.backup.age_seconds < 60);

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('rejects non-loopback host headers', async () => {
  const db = openMemoryDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), 'reading-api-test-'));
  const server = createReadingApi({ ...testConfig(dataDir), port: 4727 }, db);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const base = `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`;

  const { status, body } = await rawGet(base, '/health', { host: 'reading-api.example.com' });

  assert.equal(status, 400);
  assert.equal(body.error.code, 'BAD_REQUEST');

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function rawGet(base: string, path: string, headers: Record<string, string>) {
  const url = new URL(path, base);
  return await new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'GET',
      headers
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
