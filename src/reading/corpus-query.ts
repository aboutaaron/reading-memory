import type { Database } from '../db/connection.js';

export function queryCorpus(db: Database, input: { query: string; topK?: number; since?: string; tags?: string[] }) {
  const topK = input.topK ?? 10;
  const terms = input.query.match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? [];
  const ftsQuery = terms.slice(0, 8).map((term) => `"${term}"`).join(' OR ');
  if (!ftsQuery) return emptyQueryResult('No searchable reading-corpus terms found.');

  const tags = input.tags ?? [];
  const rows = db.prepare(`
    SELECT i.id AS item_id, i.title, i.source_uri, snippet(item_fts, 2, '[', ']', '...', 18) AS snippet,
      bm25(item_fts) * -1 AS score
    FROM item_fts
    JOIN items i ON i.id = item_fts.item_id
    WHERE item_fts MATCH ?
      AND i.status = 'indexed'
      AND (? IS NULL OR i.ingested_at >= ?)
      AND (
        ? = 0 OR EXISTS (
          SELECT 1 FROM tags t
          WHERE t.item_id = i.id AND t.tag IN (${tags.map(() => '?').join(',') || "''"})
        )
      )
    ORDER BY score DESC
    LIMIT ?
  `).all(ftsQuery, input.since ?? null, input.since ?? null, tags.length, ...tags, topK) as Array<{
    item_id: string;
    title: string | null;
    source_uri: string | null;
    snippet: string;
    score: number;
  }>;

  if (rows.length === 0) {
    return emptyQueryResult('No matching reading-corpus items found.');
  }

  const citations = rows.slice(0, 5).map((row) => row.item_id);
  const answer = `Relevant stored reading appears in ${citations.map((id) => `[${id}]`).join(', ')}.`;
  return {
    answer,
    citations,
    results: rows.map((row) => ({
      item_id: row.item_id,
      title: row.title,
      source_uri: row.source_uri,
      snippet: row.snippet,
      score: row.score,
      match_reason: 'Matched full-text index and filters'
    })),
    confidence: Math.min(0.85, 0.55 + rows.length * 0.05),
    empty_reason: null
  };
}

function emptyQueryResult(reason: string) {
  return {
    answer: '',
    citations: [],
    results: [],
    confidence: 0,
    empty_reason: reason
  };
}

export function getItem(db: Database, itemId: string) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as Record<string, unknown> | undefined;
  if (!item) return null;
  const analysis = db.prepare('SELECT * FROM analyses WHERE item_id = ? ORDER BY created_at DESC LIMIT 1').get(itemId) as Record<string, unknown> | undefined;
  const tags = db.prepare('SELECT tag, reason, confidence FROM tags WHERE item_id = ? ORDER BY confidence DESC').all(itemId);
  const relationships = db.prepare('SELECT from_item_id, to_item_id, relation_type, explanation, confidence FROM relationships WHERE from_item_id = ? OR to_item_id = ?').all(itemId, itemId);
  return {
    item_id: item.id,
    status: item.status,
    source_type: item.source_type,
    source_uri: item.source_uri,
    title: item.title,
    content_hash: item.content_hash,
    analysis: analysis ? {
      summary: analysis.summary,
      claims: JSON.parse(String(analysis.claims_json)),
      relevance: JSON.parse(String(analysis.relevance_json)),
      recommended_action: analysis.recommended_action,
      confidence: analysis.confidence,
      model: analysis.model,
      analysis_version: analysis.analysis_version
    } : null,
    tags,
    relationships,
    provenance: JSON.parse(String(item.provenance_json))
  };
}
