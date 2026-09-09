import type { Database } from '../db/connection.js';
import { listReaderAnnotations } from './reader-annotations.js';
import type { Relationship } from './types.js';
import { extractSearchTerms, toFtsQuery } from './search-terms.js';
import { getUsageStats, USAGE_SUMMARY_CTES, USAGE_BOOST_SQL, UNUSED_DECAY_SQL } from './usage-feedback.js';

const USAGE_HINT = 'Lexical matches with a bounded usefulness multiplier, not answer confidence or reader endorsement. Event weights halve after 30 days; usage adjusts BM25 by at most +/-20%. Unused items older than 30 days with relevance below 0.35 lose up to another 10% by day 90. Lexical coverage measures matched search terms, not answer support; weak_match flags partial lexical matches. Inspect the cited sources before making claims.';

const RETRIEVAL_HINT = 'Full-text retrieval only; no answer has been synthesized. Scores are lexical BM25 ranking scores, not confidence probabilities. Lexical coverage measures matched search terms, not answer support; weak_match flags partial lexical matches. Inspect the cited sources before making claims.';

export type LexicalPolicy = 'any' | 'all';
export type LexicalMatchMetadata = {
  lexical_match: 'all_terms' | 'partial_terms' | 'not_selected';
  lexical_coverage: number | null;
  weak_match: boolean | null;
};

type QueryRow = {
  item_id: string;
  title: string | null;
  source_uri: string | null;
  snippet: string;
  score: number;
  lexical_score?: number;
  usage_count?: number;
  last_used_at?: string | null;
  skipped_count?: number;
  usage_boost?: number;
  unused_decay?: number;
};

export function queryCorpus(db: Database, input: { query: string; topK?: number; since?: string; tags?: string[]; mode?: 'fts' | 'fts+usage'; asOf?: string; lexical_policy?: LexicalPolicy }) {
  const mode = input.mode ?? 'fts';
  const lexicalPolicy = input.lexical_policy ?? 'any';
  const withUsage = mode === 'fts+usage';
  const asOf = input.asOf ?? new Date().toISOString();
  const topK = Math.max(1, Math.min(25, input.topK ?? 10));
  const terms = extractSearchTerms(input.query);
  if (terms.length === 0) return emptyQueryResult('No searchable reading-corpus terms found.', terms, mode, lexicalPolicy);

  const tags = input.tags ?? [];
  const search = db.prepare(`
    ${withUsage ? `WITH ${USAGE_SUMMARY_CTES}` : ''}
    SELECT i.id AS item_id, i.title, i.source_uri, snippet(item_fts, -1, '[', ']', '...', 18) AS snippet,
      bm25(item_fts) * -1 ${withUsage ? `* (1.0 + (${USAGE_BOOST_SQL}) - (${UNUSED_DECAY_SQL}))` : ''} AS score
      ${withUsage ? `, bm25(item_fts) * -1 AS lexical_score,
        COALESCE(u.usage_count, 0) AS usage_count, u.last_used_at,
        COALESCE(u.skipped_count, 0) AS skipped_count,
        (${USAGE_BOOST_SQL}) AS usage_boost, (${UNUSED_DECAY_SQL}) AS unused_decay` : ''}
    FROM item_fts
    JOIN items i ON i.id = item_fts.item_id
    ${withUsage ? 'LEFT JOIN usage_summary u ON u.item_id = i.id' : ''}
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
    ...(withUsage ? [asOf] : []), toFtsQuery(terms, operator), input.since ?? null, input.since ?? null, tags.length, ...tags, topK
  ) as QueryRow[];

  let rows = find('AND');
  let matchStrategy: 'all_terms' | 'partial_terms' = 'all_terms';
  if (rows.length === 0 && terms.length > 1 && lexicalPolicy === 'any') {
    rows = find('OR');
    matchStrategy = 'partial_terms';
  }

  if (rows.length === 0) {
    return emptyQueryResult(lexicalPolicy === 'all'
      ? 'No reading-corpus item matched all search terms under the applied filters; partial lexical fallback is disabled.'
      : 'No matching reading-corpus items found.', terms, mode, lexicalPolicy);
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
      ...(withUsage ? { usage: {
        lexical_score: row.lexical_score!, usage_count: row.usage_count!, last_used_at: row.last_used_at ?? null,
        skipped_count: row.skipped_count!, boost: row.usage_boost!, unused_decay: row.unused_decay!,
        multiplier: 1 + row.usage_boost! - row.unused_decay!
      } } : {}),
      match_reason: matchStrategy === 'all_terms'
        ? 'Matched all search terms in the full-text index and applied filters.'
        : 'Partial lexical match: no item matched all search terms; retried with OR and applied filters.',
      matched_terms: matchedTerms.get(row.item_id) ?? [],
      lexical_match: matchStrategy,
      lexical_coverage: (matchedTerms.get(row.item_id)?.length ?? 0) / terms.length,
      weak_match: matchStrategy === 'partial_terms'
    })),
    confidence: null,
    retrieval_mode: mode,
    lexical_policy: lexicalPolicy,
    retrieval_hint: mode === 'fts+usage' ? USAGE_HINT : RETRIEVAL_HINT,
    search_terms: terms,
    match_strategy: matchStrategy,
    empty_reason: null
  };
}

function emptyQueryResult(reason: string, terms: string[], mode: 'fts' | 'fts+usage', lexicalPolicy: LexicalPolicy) {
  return {
    answer: '',
    citations: [],
    results: [],
    confidence: 0,
    retrieval_mode: mode,
    lexical_policy: lexicalPolicy,
    retrieval_hint: mode === 'fts+usage' ? USAGE_HINT : RETRIEVAL_HINT,
    search_terms: terms,
    match_strategy: 'none' as const,
    empty_reason: reason
  };
}

export function getItem(db: Database, itemId: string, options: { includeText?: boolean } = {}) {
  const item = db.prepare(`
    SELECT id, status, source_type, source_uri, title, content_hash, truncated,
      author, publisher, published_at, provenance_json${options.includeText ? ', extracted_text' : ''}
    FROM items WHERE id = ?
  `).get(itemId) as Record<string, unknown> | undefined;
  if (!item) return null;
  const usage = getUsageStats(db, itemId);
  const analysis = db.prepare('SELECT * FROM analyses WHERE item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(itemId) as Record<string, unknown> | undefined;
  const tags = db.prepare('SELECT tag, reason, confidence FROM tags WHERE item_id = ? ORDER BY confidence DESC').all(itemId);
  const embedding = db.prepare('SELECT model, analysis_id FROM item_embeddings WHERE item_id = ?').get(itemId) as { model: string; analysis_id: string } | undefined;
  const relationships = db.prepare('SELECT from_item_id, to_item_id, relation_type, explanation, confidence, origin, evidence_json FROM relationships WHERE from_item_id = ? OR to_item_id = ?').all(itemId, itemId) as Array<Omit<Relationship, 'evidence'> & { evidence_json: string | null }>;
  return {
    item_id: item.id,
    status: item.status,
    source_type: item.source_type,
    source_uri: item.source_uri,
    title: item.title,
    content_hash: item.content_hash,
    embedding_status: embedding?.analysis_id === analysis?.id && embedding ? 'indexed' : 'missing',
    embedding_model: embedding?.model ?? null,
    truncated: Boolean(item.truncated),
    usage_count: usage.usage_count,
    last_used_at: usage.last_used_at,
    ...(options.includeText ? { extracted_text: item.extracted_text } : {}),
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
