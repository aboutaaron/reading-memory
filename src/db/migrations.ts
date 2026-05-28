import type { Database } from './connection.js';

export const CURRENT_USER_VERSION = 2;

export function migrateSchema(db: Database, fromVersion: number) {
  let version = fromVersion;
  if (version === 0) {
    return CURRENT_USER_VERSION;
  }
  if (version < 2) {
    migrateToV2(db);
    version = 2;
  }
  return version;
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
