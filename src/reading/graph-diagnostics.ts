import type { Database } from '../db/connection.js';
import { GRAPH_CANDIDATE_WHERE, GRAPH_QUOTE_CHECKS, graphEvidence } from './graph-eligibility.js';

/** Full-corpus quote validation: call on explicit authenticated diagnostics, never ordinary health requests. */
export function graphDiagnostics(db: Database) {
  const counts = db.prepare(`SELECT count(*) AS total_relationships,
    coalesce(sum(origin = 'model'), 0) AS model_relationships,
    coalesce(sum(origin = 'heuristic'), 0) AS heuristic_relationships FROM relationships`).get() as {
      total_relationships: number; model_relationships: number; heuristic_relationships: number;
    };
  const rows = db.prepare(`WITH eligible_candidates AS (
    SELECT r.evidence_json, r.confidence, r.from_item_id, r.to_item_id FROM relationships r
    JOIN items src ON src.id = r.from_item_id JOIN items dst ON dst.id = r.to_item_id
    WHERE ${GRAPH_CANDIDATE_WHERE})
    SELECT e.evidence_json, e.confidence, ${GRAPH_QUOTE_CHECKS}
    FROM eligible_candidates e JOIN items src ON src.id = e.from_item_id JOIN items dst ON dst.id = e.to_item_id`);
  let eligible_relationships = 0;
  for (const row of rows.iterate()) {
    if (graphEvidence(row as Parameters<typeof graphEvidence>[0])) eligible_relationships++;
  }
  return { ...counts, eligible_relationships,
    eligibility_hint: 'Corpus-wide model edges with supported types, indexed endpoints, bounded exact quotes in current sources, and valid model confidence. Query seed, date, tag and scan limits may further reduce expansion. Quote validity does not verify relationship meaning; analysis freshness does not determine edge eligibility.' };
}
