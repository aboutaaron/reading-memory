import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { configureDatabase, migrate } from './connection.js';
import { CURRENT_USER_VERSION } from './migrations.js';

test('usage migration preserves v5 brief history, duplicate guards, and cascade deletion', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  configureDatabase(db);
  const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
    .replace("'included', 'skipped', 'resurfaced', 'cited'", "'included', 'skipped', 'resurfaced'");
  db.exec(schema);
  db.exec('DROP TABLE item_embeddings; PRAGMA user_version = 5');
  db.exec(`INSERT INTO items (id, source_type, ingested_at, content_hash, status, extracted_text)
    VALUES ('reading', 'text', '2026-08-01T00:00:00.000Z', 'hash', 'indexed', 'source text')`);
  db.exec(`INSERT INTO brief_events VALUES
    ('history', 'reading', '2026-08-02', 'skipped', 0, 'Read later', 'morning', '2026-09-10', '2026-08-02T12:00:00.000Z')`);
  const before = db.prepare('SELECT * FROM brief_events').all();
  migrate(db);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, CURRENT_USER_VERSION);
  assert.deepEqual(db.prepare('SELECT * FROM brief_events').all(), before);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.exec(`INSERT INTO brief_events VALUES
    ('citation', 'reading', '2026-09-09', 'cited', 1, 'Supports answer', 'answer:123', NULL, '2026-09-09T12:00:00.000Z')`);
  assert.throws(() => db.exec(`INSERT INTO brief_events VALUES
    ('duplicate', 'reading', '2026-09-09', 'cited', 1, 'Supports answer', 'answer:123', NULL, '2026-09-09T12:00:00.000Z')`), /UNIQUE/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('idx_brief_events_item_date', 'idx_brief_events_resurface_after')").get()?.n, 2);
  db.exec("DELETE FROM items WHERE id = 'reading'");
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM brief_events').get()?.n, 0);
});
