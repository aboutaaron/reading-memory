/** Shared by bounded retrieval and the explicit, full-corpus diagnostics scan. */
export const GRAPH_CANDIDATE_WHERE = `r.origin = 'model'
  AND src.status = 'indexed' AND dst.status = 'indexed'
  AND length(r.evidence_json) <= 16000
  AND r.relation_type IN ('supports', 'contradicts', 'extends', 'duplicates_angle', 'related', 'updates')`;

// e, src and dst are the aliases used by both callers.
export const GRAPH_QUOTE_CHECKS = `
  CASE WHEN json_valid(e.evidence_json) THEN instr(src.extracted_text, json_extract(e.evidence_json, '$.source_quote')) > 0 ELSE 0 END AS source_quote_exists,
  CASE WHEN json_valid(e.evidence_json) THEN instr(dst.extracted_text, json_extract(e.evidence_json, '$.target_quote')) > 0 ELSE 0 END AS target_quote_exists`;

export function graphEvidence(edge: {
  evidence_json: string | null; source_quote_exists: number; target_quote_exists: number; confidence: number;
}): { source_quote: string; target_quote: string } | null {
  if (!Number.isFinite(edge.confidence) || edge.confidence < 0 || edge.confidence > 1) return null;
  try {
    const evidence: unknown = JSON.parse(edge.evidence_json ?? 'null');
    if (!evidence || typeof evidence !== 'object') return null;
    const { source_quote: source, target_quote: target } = evidence as Record<string, unknown>;
    if (typeof source !== 'string' || typeof target !== 'string'
      || !source.trim() || !target.trim() || source.length > 1500 || target.length > 1500
      || !edge.source_quote_exists || !edge.target_quote_exists) return null;
    return { source_quote: source, target_quote: target };
  } catch { return null; }
}
