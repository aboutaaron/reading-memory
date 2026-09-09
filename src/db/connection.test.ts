import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrate, openDatabase, openMemoryDatabase, reconcileFts } from './connection.js';
import { CURRENT_USER_VERSION } from './migrations.js';
import { ItemStore } from '../reading/item-store.js';
import { queryCorpus } from '../reading/corpus-query.js';
import type { Analysis, ExtractedSource } from '../reading/types.js';

const source: ExtractedSource = {
  sourceType: 'text',
  sourceUri: null,
  canonicalUrl: null,
  finalUrl: null,
  title: 'FTS recovery',
  extractedText: 'FTS recovery should rebuild missing reading corpus rows.',
  truncated: false,
  contentHash: 'sha256:fts-recovery',
  rawBytesHash: null,
  provenance: {}
};

const analysis: Analysis = {
  summary: 'FTS recovery should rebuild missing reading corpus rows.',
  claims: ['FTS recovery rebuilds rows.'],
  relevance: { score: 0.75, themes: ['fts-recovery'] },
  recommended_action: 'save',
  confidence: 0.75,
  reason: 'Regression fixture',
  tags: [{ tag: 'fts-recovery', reason: 'test', confidence: 0.9 }],
  relationships: [],
  model: 'test',
  analysis_version: 'test'
};

test('refuses to stamp an incompatible v0 database as current', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE items (id TEXT PRIMARY KEY)');

  assert.throws(
    () => migrate(db),
    /user_version 0.*app tables already exist/
  );
});

test('reconciles missing FTS rows from canonical corpus tables', async () => {
  const db = openMemoryDatabase();
  const store = new ItemStore(db);
  const ingested = await store.ingest({
    principal: 'token:test',
    requestId: 'req-fts',
    payloadHash: 'sha256:req-fts',
    source,
    analyze: async () => analysis
  });

  assert.deepEqual(queryCorpus(db, { query: 'recovery' }).citations, [ingested.item_id]);

  db.prepare('DELETE FROM item_fts WHERE item_id = ?').run(ingested.item_id);
  assert.deepEqual(queryCorpus(db, { query: 'recovery' }).citations, []);

  reconcileFts(db);
  assert.deepEqual(queryCorpus(db, { query: 'recovery' }).citations, [ingested.item_id]);
});

test('migrates existing v1 database to current schema without dropping corpus rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reading-db-migration-'));
  const path = join(dir, 'reading.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL CHECK (source_type IN ('url', 'text', 'pdf_url')),
      source_uri TEXT,
      canonical_url TEXT,
      final_url TEXT,
      title TEXT,
      author TEXT,
      publisher TEXT,
      published_at TEXT,
      ingested_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      raw_bytes_hash TEXT,
      status TEXT NOT NULL CHECK (status IN ('analyzing', 'indexed', 'failed')),
      extracted_text TEXT NOT NULL,
      truncated INTEGER NOT NULL DEFAULT 0,
      supersedes_item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
      provenance_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE (content_hash)
    );
    CREATE TABLE analyses (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      summary TEXT NOT NULL,
      claims_json TEXT NOT NULL DEFAULT '[]',
      relevance_json TEXT NOT NULL DEFAULT '{}',
      recommended_action TEXT NOT NULL,
      confidence REAL NOT NULL,
      model TEXT NOT NULL,
      analysis_version TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE tags (
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      reason TEXT NOT NULL,
      confidence REAL NOT NULL,
      PRIMARY KEY (item_id, tag)
    );
    CREATE TABLE relationships (
      id TEXT PRIMARY KEY,
      from_item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      to_item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL,
      explanation TEXT NOT NULL,
      confidence REAL NOT NULL,
      created_at TEXT NOT NULL,
      CHECK (from_item_id <> to_item_id),
      UNIQUE (from_item_id, to_item_id, relation_type)
    );
    CREATE TABLE idempotency_keys (
      principal TEXT NOT NULL,
      request_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
      response_snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (principal, request_id)
    );
    CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      principal TEXT NOT NULL,
      request_id TEXT,
      item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE item_fts USING fts5(item_id UNINDEXED, title, body, summary, tags);
    PRAGMA user_version = 1;
  `);
  db.prepare(`
    INSERT INTO items (
      id, source_type, title, ingested_at, content_hash, status, extracted_text, truncated, provenance_json
    ) VALUES ('item_v1', 'text', 'V1 item', ?, 'sha256:v1', 'indexed', 'semantic layer text', 0, '{}')
  `).run(new Date().toISOString());
  db.prepare(`INSERT INTO items (
    id, source_type, title, ingested_at, content_hash, status, extracted_text, truncated, provenance_json
  ) VALUES ('item_v1_truncated', 'url', 'Old prefix', ?, 'sha256:old-prefix', 'indexed', 'old prefix', 1, '{}')`)
    .run(new Date().toISOString());
  db.close();

  const migrated = openDatabase(path);
  const version = migrated.prepare('PRAGMA user_version').get() as { user_version: number };
  const item = migrated.prepare("SELECT title FROM items WHERE id = 'item_v1'").get() as { title: string };
  const briefEvents = migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'brief_events'").get();
  const canonicalIndex = migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_items_canonical_url'").get();

  assert.equal(version.user_version, CURRENT_USER_VERSION);
  assert.equal(item.title, 'V1 item');
  assert.equal(migrated.prepare("SELECT content_hash FROM items WHERE id = 'item_v1_truncated'").get()?.content_hash,
    'legacy-prefix:sha256:old-prefix');
  assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE name = 'reader_annotations'").get());
  assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(queryCorpus(migrated, { query: 'semantic layer' }).results[0]?.item_id, 'item_v1');
  assert.ok(briefEvents);
  assert.ok(canonicalIndex);
  migrated.close();
});

test('refuses databases newer than current schema version', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA user_version = 999');
  assert.throws(() => migrate(db), /newer than this service/);
});

test('fresh databases omit the unused sessions table', () => {
  const db = openMemoryDatabase();
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'sessions'").get(), undefined);
  db.close();
});

for (const legacyState of ['missing', 'empty', 'populated'] as const) {
  test(`v4 migration handles a ${legacyState} legacy sessions table without losing data`, () => {
    const db = openMemoryDatabase();
    db.exec('DROP TABLE analysis_jobs; PRAGMA user_version = 3');
    if (legacyState !== 'missing') {
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)');
      if (legacyState === 'populated') {
        db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('legacy-session', '{"opaque":true}', '2026-01-01');
      }
    }
    migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, CURRENT_USER_VERSION);
    const table = db.prepare("SELECT name FROM sqlite_master WHERE name = 'sessions'").get();
    if (legacyState === 'populated') {
      assert.ok(table);
      assert.deepEqual({ ...db.prepare('SELECT * FROM sessions').get() }, {
        id: 'legacy-session', data: '{"opaque":true}', updated_at: '2026-01-01'
      });
    } else {
      assert.equal(table, undefined);
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.doesNotThrow(() => migrate(db), 'reopening the migrated database must be safe');
    db.close();
  });
}

test('does not rebuild FTS rows for incomplete ingests', () => {
  const db = openMemoryDatabase();
  db.prepare(`
    INSERT INTO items (
      id, source_type, title, ingested_at, content_hash, status, extracted_text, truncated, provenance_json
    ) VALUES (?, 'text', ?, ?, ?, 'analyzing', ?, 0, '{}')
  `).run(
    'item_incomplete',
    'Incomplete',
    new Date().toISOString(),
    'sha256:incomplete',
    'unfinished content should not be searchable'
  );

  reconcileFts(db);

  assert.deepEqual(queryCorpus(db, { query: 'unfinished searchable' }).citations, []);
});
