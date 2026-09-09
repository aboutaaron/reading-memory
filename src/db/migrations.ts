import type { Database } from './connection.js';

export const CURRENT_USER_VERSION = 7;

export function migrateSchema(db: Database, fromVersion: number) {
  let version = fromVersion;
  if (version === 0) {
    return CURRENT_USER_VERSION;
  }
  if (version < 2) {
    migrateToV2(db);
    version = 2;
  }
  if (version < 3) {
    migrateToV3(db);
    version = 3;
  }
  if (version < 4) {
    migrateToV4(db);
    version = 4;
  }
  if (version < 5) {
    migrateToV5(db);
    version = 5;
  }
  if (version < 6) {
    migrateToV6(db);
    version = 6;
  }
  if (version < 7) {
    migrateToV7(db);
    version = 7;
  }
  return version;
}

function migrateToV4(db: Database) {
  const legacyTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get();
  // Opaque legacy framework state is not ours to discard. Remove only an empty table.
  if (legacyTable && !db.prepare('SELECT 1 FROM sessions LIMIT 1').get()) {
    db.exec('DROP TABLE sessions');
  }
}

function migrateToV3(db: Database) {
  db.exec(`
    -- A legacy prefix digest cannot safely identify a complete source. Keep its
    -- original digest visible while preventing collisions with new full hashes.
    UPDATE items SET content_hash = 'legacy-prefix:' || content_hash WHERE truncated = 1;
    ALTER TABLE analyses ADD COLUMN reason TEXT;
    ALTER TABLE relationships ADD COLUMN origin TEXT NOT NULL DEFAULT 'heuristic' CHECK (origin IN ('model', 'heuristic'));
    ALTER TABLE relationships ADD COLUMN evidence_json TEXT;
    CREATE TABLE reader_annotations (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent')),
      actor TEXT NOT NULL,
      note TEXT NOT NULL,
      project TEXT,
      question TEXT,
      supersedes_annotation_id TEXT UNIQUE REFERENCES reader_annotations(id),
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_reader_annotations_item ON reader_annotations(item_id, created_at);
    DROP TABLE item_fts;
    CREATE VIRTUAL TABLE item_fts USING fts5(item_id UNINDEXED, title, body, summary, tags, reader_notes);
  `);
}

function migrateToV2(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS brief_events (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      brief_date TEXT NOT NULL,
      event_kind TEXT NOT NULL CHECK (event_kind IN ('included', 'skipped', 'resurfaced')),
      included_bool INTEGER NOT NULL CHECK (included_bool IN (0, 1)),
      rationale TEXT NOT NULL,
      source_context TEXT NOT NULL DEFAULT '',
      resurface_after TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (item_id, brief_date, event_kind, source_context)
    );

    CREATE INDEX IF NOT EXISTS idx_items_canonical_url ON items(canonical_url);
    CREATE INDEX IF NOT EXISTS idx_items_final_url ON items(final_url);
    CREATE INDEX IF NOT EXISTS idx_brief_events_item_date ON brief_events(item_id, brief_date);
    CREATE INDEX IF NOT EXISTS idx_brief_events_resurface_after ON brief_events(resurface_after);
  `);
}

function migrateToV5(db: Database) {
  db.exec(`CREATE TABLE analysis_jobs (
    item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    principal TEXT NOT NULL,
    request_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    UNIQUE (principal, request_id)
  )`);
}

function migrateToV6(db: Database) {
  // brief_events has no inbound foreign keys. Rebuild its CHECK constraint in
  // the migration transaction, retaining IDs, history, uniqueness, and indexes.
  db.exec(`
    CREATE TABLE brief_events_next (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      brief_date TEXT NOT NULL,
      event_kind TEXT NOT NULL CHECK (event_kind IN ('included', 'skipped', 'resurfaced', 'cited')),
      included_bool INTEGER NOT NULL CHECK (included_bool IN (0, 1)),
      rationale TEXT NOT NULL,
      source_context TEXT NOT NULL DEFAULT '',
      resurface_after TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (item_id, brief_date, event_kind, source_context)
    );
    INSERT INTO brief_events_next SELECT * FROM brief_events;
    DROP TABLE brief_events;
    ALTER TABLE brief_events_next RENAME TO brief_events;
    CREATE INDEX idx_brief_events_item_date ON brief_events(item_id, brief_date);
    CREATE INDEX idx_brief_events_resurface_after ON brief_events(resurface_after);
  `);
}

function migrateToV7(db: Database) {
  db.exec(`
    CREATE TABLE item_embeddings (
      item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
      analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL CHECK (dimensions = 1536),
      input_hash TEXT NOT NULL,
      embedding BLOB NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}
