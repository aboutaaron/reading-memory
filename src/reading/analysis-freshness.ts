import type { Database } from '../db/connection.js';

const STALE_ITEMS = `FROM items i
  LEFT JOIN analyses a ON a.rowid = (SELECT rowid FROM analyses WHERE item_id = i.id ORDER BY created_at DESC, rowid DESC LIMIT 1)
  WHERE i.status = 'indexed' AND (a.id IS NULL OR a.analysis_version <> ? OR (CASE WHEN instr(a.model, '/') = 0 THEN 'openai/' || a.model ELSE a.model END) <> ?)`;

export function analysisFreshness(db: Database, currentVersion: string, currentModel: string) {
  currentModel = canonicalAnalysisModel(currentModel);
  const row = db.prepare(`SELECT count(*) AS count ${STALE_ITEMS}`).get(currentVersion, currentModel) as { count: number };
  return { current_version: currentVersion, current_model: currentModel, stale_items: row.count };
}

export function listStaleItems(db: Database, currentVersion: string, currentModel: string, limit: number) {
  currentModel = canonicalAnalysisModel(currentModel);
  const items = db.prepare(`SELECT i.id AS item_id, i.title, a.analysis_version, a.model ${STALE_ITEMS}
    ORDER BY i.ingested_at ASC, i.id ASC LIMIT ?`).all(currentVersion, currentModel, limit);
  return { items, current_version: currentVersion, current_model: currentModel };
}

/** Matches provider routing syntax without requiring credentials or a network call. */
function canonicalAnalysisModel(model: string) {
  return model.includes('/') ? model : `openai/${model}`;
}
