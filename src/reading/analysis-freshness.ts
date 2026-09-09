import type { Database } from '../db/connection.js';

const FRESHNESS = `FROM items i
  LEFT JOIN analyses a ON a.rowid = (SELECT rowid FROM analyses WHERE item_id = i.id ORDER BY created_at DESC, rowid DESC LIMIT 1)
  WHERE i.status = 'indexed'`;
const MODEL = `(CASE WHEN instr(a.model, '/') = 0 THEN 'openai/' || a.model ELSE a.model END)`;
const STALE = `(a.id IS NULL OR a.analysis_version <> ? OR ${MODEL} <> ?)`;
export type StaleReason = 'missing_analysis' | 'version_mismatch' | 'model_mismatch';

export function analysisFreshness(db: Database, currentVersion: string, currentModel: string) {
  currentModel = canonicalAnalysisModel(currentModel);
  const row = db.prepare(`SELECT count(*) AS stale_items,
    coalesce(sum(a.id IS NULL), 0) AS missing_analysis,
    coalesce(sum(a.id IS NOT NULL AND a.analysis_version <> ?), 0) AS version_mismatch,
    coalesce(sum(a.id IS NOT NULL AND ${MODEL} <> ?), 0) AS model_mismatch
    ${FRESHNESS} AND ${STALE}`).get(currentVersion, currentModel, currentVersion, currentModel) as {
      stale_items: number; missing_analysis: number; version_mismatch: number; model_mismatch: number;
    };
  const { stale_items, ...stale_reason_counts } = row;
  return { current_version: currentVersion, current_model: currentModel, stale_items, stale_reason_counts };
}

export function listStaleItems(db: Database, currentVersion: string, currentModel: string, limit: number) {
  currentModel = canonicalAnalysisModel(currentModel);
  const rows = db.prepare(`SELECT i.id AS item_id, i.title, a.id AS analysis_id, a.analysis_version, a.model ${FRESHNESS} AND ${STALE}
    ORDER BY i.ingested_at ASC, i.id ASC LIMIT ?`).all(currentVersion, currentModel, limit) as Array<{
      item_id: string; title: string | null; analysis_id: string | null; analysis_version: string | null; model: string | null;
    }>;
  const items = rows.map(({ analysis_id, ...item }) => {
    const stale_reasons: StaleReason[] = [];
    if (analysis_id === null) stale_reasons.push('missing_analysis');
    else {
      if (item.analysis_version !== currentVersion) stale_reasons.push('version_mismatch');
      if (canonicalAnalysisModel(item.model!) !== currentModel) stale_reasons.push('model_mismatch');
    }
    return { ...item, stale_reasons };
  });
  return { items, current_version: currentVersion, current_model: currentModel };
}

/** Matches provider routing syntax without requiring credentials or a network call. */
export function canonicalAnalysisModel(model: string) {
  return model.includes('/') ? model : `openai/${model}`;
}
