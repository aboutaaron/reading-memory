import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
const CURRENT_USER_VERSION = 1;

export type Database = DatabaseSync;

export function openDatabase(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  configureDatabase(db);
  migrate(db);
  reconcileFts(db);
  return db;
}

export function openMemoryDatabase(): Database {
  const db = new DatabaseSync(':memory:');
  configureDatabase(db);
  migrate(db);
  reconcileFts(db);
  return db;
}

export function configureDatabase(db: Database) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
  `);
}

export function migrate(db: Database) {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (row.user_version > CURRENT_USER_VERSION) {
    throw new Error(`Database user_version ${row.user_version} is newer than this service`);
  }

  if (row.user_version === 0) {
    assertEmptyV0Database(db);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(SCHEMA);
      db.exec(`PRAGMA user_version = ${CURRENT_USER_VERSION}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

export function reconcileFts(db: Database) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM item_fts').run();
    db.prepare(`
      INSERT INTO item_fts (item_id, title, body, summary, tags)
      SELECT i.id, coalesce(i.title, ''), i.extracted_text, coalesce(a.summary, ''), coalesce(group_concat(t.tag, ' '), '')
      FROM items i
      LEFT JOIN analyses a ON a.item_id = i.id
      LEFT JOIN tags t ON t.item_id = i.id
      WHERE i.status = 'indexed'
      GROUP BY i.id
    `).run();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function assertEmptyV0Database(db: Database) {
  const appTables = [
    'items',
    'analyses',
    'tags',
    'relationships',
    'idempotency_keys',
    'sessions',
    'activity_log',
    'item_fts'
  ];
  const placeholders = appTables.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type IN ('table', 'view')
      AND name IN (${placeholders})
    ORDER BY name
  `).all(...appTables) as Array<{ name: string }>;

  if (rows.length > 0) {
    throw new Error(
      `Refusing to initialize database with user_version 0 because app tables already exist: ${rows.map((row) => row.name).join(', ')}`
    );
  }
}

export function transaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
