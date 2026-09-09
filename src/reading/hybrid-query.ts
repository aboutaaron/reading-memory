import type { Database } from '../db/connection.js';
import { queryCorpus } from './corpus-query.js';
import { vectorIndexAvailable, vectorNeighbors, type Embedder } from './embeddings.js';

const HINT = 'Hybrid retrieval fuses lexical and vector ranks (RRF k=60). Scores are ranking signals, not confidence. Vector candidates require cosine distance <=0.5, an uncalibrated relevance guard. Inspect sources before making claims.';
export async function queryHybridCorpus(db: Database, input: Parameters<typeof queryCorpus>[1], embedder: Embedder | null) {
  const topK = Math.max(1, Math.min(25, input.topK ?? 10));
  let lexical = queryCorpus(db, { ...input, mode: 'fts', topK: 25 });
  const fallback = (reason: string) => ({ ...lexical, results: lexical.results.slice(0, topK),
    citations: lexical.citations.slice(0, topK), requested_mode: 'hybrid' as const, fallback_reason: reason });
  if (!lexical.search_terms.length) return fallback('no_search_terms');
  if (!embedder || !vectorIndexAvailable(db)) return fallback('embeddings_unavailable');
  const compatible = db.prepare(`SELECT 1 FROM item_embeddings e JOIN items i ON i.id = e.item_id
    WHERE i.status = 'indexed' AND e.model = ? AND e.analysis_id =
      (SELECT id FROM analyses WHERE item_id = i.id ORDER BY created_at DESC, rowid DESC LIMIT 1) LIMIT 1`).get(embedder.model);
  if (!compatible) return fallback('no_compatible_embeddings');
  try {
    const vector = await embedder.embed(input.query, AbortSignal.timeout(5000));
    // An item may be forgotten while the provider is running. Return current corpus state.
    lexical = queryCorpus(db, { ...input, mode: 'fts', topK: 25 });
    const semantic = vectorNeighbors(db, vector, embedder.model, {
      topK: 25, ...(input.since ? { since: input.since } : {}), ...(input.tags ? { tags: input.tags } : {})
    }).filter(hit => hit.distance <= 0.5);
    type Hit = { item_id: string; title: string | null; source_uri: string | null; snippet: string;
      score: number; lexical_rank: number | null; vector_rank: number | null; cosine_distance: number | null;
      matched_terms: string[]; match_reason: string };
    const fused = new Map<string, Hit>();
    lexical.results.forEach((hit, index) => fused.set(hit.item_id, { ...hit, score: 1 / (61 + index),
      lexical_rank: index + 1, vector_rank: null, cosine_distance: null }));
    semantic.forEach((hit, index) => {
      const current = fused.get(hit.item_id);
      fused.set(hit.item_id, { ...(current ?? { item_id: hit.item_id, title: hit.title, source_uri: hit.source_uri,
        snippet: hit.snippet, matched_terms: [], lexical_rank: null }),
        score: (current?.score ?? 0) + 1 / (61 + index), vector_rank: index + 1, cosine_distance: hit.distance,
        match_reason: current ? 'Matched lexical terms and a semantic vector neighbor.' : 'Semantic vector neighbor; no lexical match among selected candidates.' });
    });
    const results = [...fused.values()].sort((a, b) => b.score - a.score || a.item_id.localeCompare(b.item_id)).slice(0, topK);
    return { answer: '', citations: results.map(hit => hit.item_id), results,
      confidence: results.length ? null : 0, retrieval_mode: 'hybrid' as const, requested_mode: 'hybrid' as const,
      retrieval_hint: HINT, search_terms: lexical.search_terms, match_strategy: results.length ? 'rank_fusion' : 'none',
      empty_reason: results.length ? null : 'No matching reading-corpus items found.', fallback_reason: null };
  } catch {
    lexical = queryCorpus(db, { ...input, mode: 'fts', topK: 25 });
    return fallback('embedding_query_failed');
  }
}
