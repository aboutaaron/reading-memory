import type { Database } from '../db/connection.js';
import { listReaderAnnotations } from './reader-annotations.js';
import type { Relationship } from './types.js';
import { extractSearchTerms, toFtsQuery } from './search-terms.js';

const RETRIEVAL_HINT = 'Full-text retrieval only; no answer has been synthesized. Scores are lexical BM25 ranking scores, not confidence probabilities. Inspect the cited sources before making claims.';

type QueryRow = {
  item_id: string;
  title: string | null;
  source_uri: string | null;
  snippet: string;
  score: number;
};

export function queryCorpus(db: Database, input: { query: string; topK?: number; since?: string; tags?: string[] }) {
  const topK = Math.max(1, Math.min(25, input.topK ?? 10));
  const terms = extractSearchTerms(input.query);
  if (terms.length === 0) return emptyQueryResult('No searchable reading-corpus terms found.', terms);

  const tags = input.tags ?? [];
  const search = db.prepare(`
    SELECT i.id AS item_id, i.title, i.source_uri, snippet(item_fts, -1, '[', ']', '...', 18) AS snippet,
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
    ORDER BY score DESC, i.ingested_at DESC, i.id ASC
    LIMIT ?
  `);
  const find = (operator: 'AND' | 'OR') => search.all(
    toFtsQuery(terms, operator), input.since ?? null, input.since ?? null, tags.length, ...tags, topK
  ) as QueryRow[];

  let rows = find('AND');
  let matchStrategy: 'all_terms' | 'partial_terms' = 'all_terms';
  if (rows.length === 0 && terms.length > 1) {
    rows = find('OR');
    matchStrategy = 'partial_terms';
  }

  if (rows.length === 0) {
    return emptyQueryResult('No matching reading-corpus items found.', terms);
  }

  // Ask FTS itself which terms matched, including matches in titles, summaries,
  // and tags. Substring checks would misreport word boundaries and diacritics.
  const matchedTerms = new Map(rows.map((row) => [row.item_id, [] as string[]]));
  if (matchStrategy === 'all_terms') {
    for (const row of rows) matchedTerms.set(row.item_id, terms);
  } else {
    const termMatches = db.prepare(`
      SELECT item_id FROM item_fts
      WHERE item_fts MATCH ? AND item_id IN (${rows.map(() => '?').join(',')})
    `);
    for (const term of terms) {
      const matches = termMatches.all(toFtsQuery([term]), ...rows.map((row) => row.item_id)) as Array<{ item_id: string }>;
      for (const match of matches) matchedTerms.get(match.item_id)?.push(term);
    }
  }

  return {
    answer: '',
    citations: rows.map((row) => row.item_id),
    results: rows.map((row) => ({
      item_id: row.item_id,
      title: row.title,
      source_uri: row.source_uri,
      snippet: row.snippet,
      score: row.score,
      match_reason: matchStrategy === 'all_terms'
        ? 'Matched all search terms in the full-text index and applied filters.'
        : 'Partial lexical match: no item matched all search terms; retried with OR and applied filters.',
      matched_terms: matchedTerms.get(row.item_id) ?? []
    })),
    confidence: null,
    retrieval_mode: 'fts' as const,
    retrieval_hint: RETRIEVAL_HINT,
    search_terms: terms,
    match_strategy: matchStrategy,
    empty_reason: null
  };
}

function emptyQueryResult(reason: string, terms: string[]) {
  return {
    answer: '',
    citations: [],
    results: [],
    confidence: 0,
    retrieval_mode: 'fts' as const,
    retrieval_hint: RETRIEVAL_HINT,
    search_terms: terms,
    match_strategy: 'none' as const,
    empty_reason: reason
  };
}

export function getItem(db: Database, itemId: string) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as Record<string, unknown> | undefined;
  if (!item) return null;
  const analysis = db.prepare('SELECT * FROM analyses WHERE item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(itemId) as Record<string, unknown> | undefined;
  const tags = db.prepare('SELECT tag, reason, confidence FROM tags WHERE item_id = ? ORDER BY confidence DESC').all(itemId);
  const relationships = db.prepare('SELECT from_item_id, to_item_id, relation_type, explanation, confidence, origin, evidence_json FROM relationships WHERE from_item_id = ? OR to_item_id = ?').all(itemId, itemId) as Array<Omit<Relationship, 'evidence'> & { evidence_json: string | null }>;
  return {
    item_id: item.id,
    status: item.status,
    source_type: item.source_type,
    source_uri: item.source_uri,
    title: item.title,
    content_hash: item.content_hash,
    truncated: Boolean(item.truncated),
    extracted_text: item.extracted_text,
    author: item.author,
    publisher: item.publisher,
    published_at: item.published_at,
    analysis: analysis ? {
      summary: analysis.summary,
      reason: analysis.reason ?? null,
      claims: JSON.parse(String(analysis.claims_json)),
      relevance: JSON.parse(String(analysis.relevance_json)),
      recommended_action: analysis.recommended_action,
      confidence: analysis.confidence,
      model: analysis.model,
      analysis_version: analysis.analysis_version
    } : null,
    tags,
    relationships: relationships.map(({ evidence_json, ...relationship }) => ({
      ...relationship,
      ...(evidence_json ? { evidence: JSON.parse(String(evidence_json)) } : {})
    })),
    reader_annotations: listReaderAnnotations(db, itemId),
    provenance: JSON.parse(String(item.provenance_json))
  };
}
