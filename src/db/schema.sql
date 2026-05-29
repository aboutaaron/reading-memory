CREATE TABLE IF NOT EXISTS items (
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

CREATE TABLE IF NOT EXISTS analyses (
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

CREATE TABLE IF NOT EXISTS tags (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  reason TEXT NOT NULL,
  confidence REAL NOT NULL,
  PRIMARY KEY (item_id, tag)
);

CREATE TABLE IF NOT EXISTS relationships (
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

CREATE TABLE IF NOT EXISTS idempotency_keys (
  principal TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  response_snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (principal, request_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  principal TEXT NOT NULL,
  request_id TEXT,
  item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

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

CREATE VIRTUAL TABLE IF NOT EXISTS item_fts USING fts5(
  item_id UNINDEXED,
  title,
  body,
  summary,
  tags
);

CREATE INDEX IF NOT EXISTS idx_items_ingested_at ON items(ingested_at);
CREATE INDEX IF NOT EXISTS idx_items_source_uri ON items(source_uri);
CREATE INDEX IF NOT EXISTS idx_items_canonical_url ON items(canonical_url);
CREATE INDEX IF NOT EXISTS idx_items_final_url ON items(final_url);
CREATE INDEX IF NOT EXISTS idx_analyses_item_id ON analyses(item_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_idempotency_expires_at ON idempotency_keys(expires_at);
CREATE INDEX IF NOT EXISTS idx_brief_events_item_date ON brief_events(item_id, brief_date);
CREATE INDEX IF NOT EXISTS idx_brief_events_resurface_after ON brief_events(resurface_after);
