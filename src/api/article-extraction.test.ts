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
