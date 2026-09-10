import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openMemoryDatabase } from '../db/connection.js';
import { createReadingApi } from './server.js';
import { extractSource } from '../reading/extract-source.js';

test('consent-only URL ingestion fails before provider analysis or FTS indexing', async (t) => {
  const db = openMemoryDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), 'reading-article-quality-'));
  let analysisCalls = 0;
  const html = '<main><h1>Your privacy</h1><p>We use cookies to personalize content.</p><button>Accept all</button></main>';
  const bytes = new TextEncoder().encode(html);
  const server = createReadingApi({ host: '127.0.0.1', port: 0, dbPath: ':memory:', authToken: 'test-token', dataDir,
    backupDir: join(dataDir, 'backups'), flueModel: 'test', flueTracePath: null }, db, {
    analyzer: async () => { analysisCalls += 1; throw new Error('Analysis must not run'); },
    extractor: (request, signal) => extractSource(request, signal, {
      fetchUrl: async () => ({ bytes, rawBytesHashInput: bytes, mime: 'text/html', finalUrl: 'https://example.com/article' })
    })
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/ingest`, {
    method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ request_id: randomUUID(), source_type: 'url', source: { url: 'https://example.com/article' } })
  });
  assert.equal(response.status, 422);
  const payload = await response.json() as { ok: boolean; error: { code: string } };
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'FETCH_FAILED');
  assert.equal(analysisCalls, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM items WHERE status = 'indexed'").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM item_fts WHERE item_fts MATCH 'cookies'").get() as { n: number }).n, 0);
});

for (const withFailedHistory of [false, true]) {
  test(`analytics consent shells at distinct URLs cannot reach deduplication or indexing (${withFailedHistory ? 'existing failed lineage' : 'empty corpus'})`, async (t) => {
    const db = openMemoryDatabase();
    const dataDir = mkdtempSync(join(tmpdir(), 'reading-analytics-notice-'));
    const text = 'We use analytics and advertising tools by default. You can update this anytime.';
    const html = `<html><head><title>Example article</title></head><body><main><p>${text}</p></main></body></html>`;
    const bytes = new TextEncoder().encode(html);
    const urls = ['https://example.com/first', 'https://example.com/second'];
    const fetched: string[] = [];
    let analysisCalls = 0;
    let embeddingCalls = 0;
    if (withFailedHistory) {
      // Simulate legacy failed captures, including an identical shell hash that
      // would otherwise be retried/deduplicated across these distinct URLs.
      const insert = db.prepare(`INSERT INTO items
        (id, source_type, source_uri, canonical_url, final_url, title, ingested_at,
         content_hash, status, extracted_text, supersedes_item_id, provenance_json)
        VALUES (?, 'url', ?, ?, ?, 'Prior failed capture', ?, ?, 'failed', ?, ?, '{}')`);
      for (const [id, prior, body, date] of [
        ['item_old', null, 'Earlier retained capture.', '2026-01-01T00:00:00.000Z'],
        ['item_shell', 'item_old', text, '2026-01-02T00:00:00.000Z']
      ] as const) insert.run(id, urls[0]!, urls[0]!, urls[0]!, date, createHash('sha256').update(body).digest('hex'), body, prior);
    }
    const before = db.prepare('SELECT * FROM items ORDER BY id').all();
    const server = createReadingApi({ host: '127.0.0.1', port: 0, dbPath: ':memory:', authToken: 'test-token', dataDir,
      backupDir: join(dataDir, 'backups'), flueModel: 'test', flueTracePath: null }, db, {
      analyzer: async () => { analysisCalls += 1; throw new Error('Analysis must not run'); },
      embedder: { model: 'openai/test', async embed() { embeddingCalls += 1; throw new Error('Embedding must not run'); } },
      extractor: (request, signal) => extractSource(request, signal, {
        fetchUrl: async (url) => { fetched.push(url); return { bytes, rawBytesHashInput: bytes, mime: 'text/html', finalUrl: url }; }
      })
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    });
    for (const url of urls) {
      const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/ingest`, {
        method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({ request_id: randomUUID(), source_type: 'url', source: { url } })
      });
      assert.equal(response.status, 422);
      const payload = await response.json() as { ok: boolean; data: unknown; error: { code: string } };
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, 'FETCH_FAILED');
      assert.equal(payload.data, null);
      assert.doesNotMatch(JSON.stringify(payload), /analytics|advertising|tools by default/);
      assert.deepEqual(db.prepare('SELECT * FROM items ORDER BY id').all(), before);
    }
    assert.deepEqual(fetched, urls);
    assert.equal(analysisCalls, 0);
    assert.equal(embeddingCalls, 0);
    for (const table of ['analyses', 'item_embeddings', 'idempotency_keys']) {
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
    }
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM items WHERE status = 'indexed'").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM item_fts WHERE item_fts MATCH 'analytics OR advertising'").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE type LIKE 'ingest.%'").get() as { n: number }).n, 0);
  });
}
