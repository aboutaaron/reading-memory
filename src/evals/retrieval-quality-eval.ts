import { openMemoryDatabase, rebuildItemFts, type Database } from '../db/connection.js';
import { queryCorpus } from '../reading/corpus-query.js';
import { EMBEDDING_DIMENSIONS, embeddingHash, saveEmbedding, type Embedder } from '../reading/embeddings.js';
import { queryGraphCorpus } from '../reading/graph-query.js';
import { queryHybridCorpus } from '../reading/hybrid-query.js';
import type { ReadingMemoryEvalResult } from './reading-memory-eval.js';

const MODEL = 'synthetic/retrieval-quality';
const DATE = '2026-09-09T12:00:00.000Z';
const PARAPHRASE = 'purging obsolete memoized answers';
const SOURCE = 'Cache invalidation prevents stale computation.';
const SUPPORT = 'Versioned entries prevent stale reuse.';
const CONTRADICTION = 'Immediate refresh overloads upstream services.';

function axis(index: number) {
  const vector = Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[index] = 1;
  return vector;
}

// Deliberately assigned coordinates and relationships verify routing, not model quality.
const embedder: Embedder = { model: MODEL, embed: async (query) => axis(query === PARAPHRASE || query === 'cache invalidation' ? 0 : 1535) };

function seed(db: Database, id: string, text: string, vector = axis(1)) {
  db.prepare(`INSERT INTO items (id, source_type, title, ingested_at, content_hash, status, extracted_text)
    VALUES (?, 'text', 'Synthetic evaluation source', ?, ?, 'indexed', ?)`)
    .run(id, DATE, `sha256:quality-${id}`, text);
  db.prepare(`INSERT INTO analyses (id, item_id, summary, recommended_action, confidence, model, analysis_version, created_at)
    VALUES (?, ?, ?, 'save', 0.8, 'canned-analysis', 'synthetic-v1', ?)`)
    .run(`analysis_${id}`, id, text, DATE);
  saveEmbedding(db, id, `analysis_${id}`, { model: MODEL, vector, inputHash: embeddingHash(text) });
  rebuildItemFts(db, id);
}

function edge(db: Database, id: string, from: string, to: string, relation: string, source: string, target: string,
  origin: 'model' | 'heuristic' = 'model') {
  db.prepare(`INSERT INTO relationships (id, from_item_id, to_item_id, relation_type, explanation, confidence,
    created_at, origin, evidence_json) VALUES (?, ?, ?, ?, ?, 0.8, ?, ?, ?)`)
    .run(id, from, to, relation, `Synthetic ${relation} interpretation.`, DATE, origin,
      JSON.stringify({ source_quote: source, target_quote: target }));
}

export async function runRetrievalQualityEval(): Promise<ReadingMemoryEvalResult[]> {
  const db = openMemoryDatabase();
  try {
    seed(db, 'quality-seed', SOURCE, axis(0));
    seed(db, 'quality-support', SUPPORT);
    seed(db, 'quality-contradiction', CONTRADICTION);
    seed(db, 'quality-noise', 'Garden soil retains moisture.');
    seed(db, 'quality-second-hop', 'Quiet queues absorb bursts.');
    edge(db, 'quality-support-edge', 'quality-support', 'quality-seed', 'supports', SUPPORT, SOURCE);
    edge(db, 'quality-contradiction-edge', 'quality-seed', 'quality-contradiction', 'contradicts', SOURCE, CONTRADICTION);
    edge(db, 'quality-invalid-edge', 'quality-seed', 'quality-noise', 'supports', 'This quote does not occur.', 'Garden soil retains moisture.');
    edge(db, 'quality-heuristic-edge', 'quality-seed', 'quality-noise', 'related', SOURCE, 'Garden soil retains moisture.', 'heuristic');
    edge(db, 'quality-second-hop-edge', 'quality-support', 'quality-second-hop', 'extends', SUPPORT, 'Quiet queues absorb bursts.');

    const results: ReadingMemoryEvalResult[] = [];
    const direct = queryCorpus(db, { query: 'cache invalidation', lexical_policy: 'all', topK: 5 });
    results.push({ fixture_id: 'lexical-all-preserves-direct-positive', check: 'lexical_policy',
      passed: direct.citations.join() === 'quality-seed' && direct.results.every(hit => hit.lexical_match === 'all_terms'
        && hit.lexical_coverage === 1 && hit.weak_match === false) && direct.answer === '' && direct.confidence === null,
      details: { expected: ['quality-seed'], returned: direct.citations, lexical_policy: direct.lexical_policy } });

    const absentQuery = 'cache extraterrestrial';
    const broad = queryCorpus(db, { query: absentQuery, lexical_policy: 'any', topK: 5 });
    const strict = queryCorpus(db, { query: absentQuery, lexical_policy: 'all', topK: 5 });
    results.push({ fixture_id: 'lexical-near-miss-explicit-policy', check: 'lexical_policy',
      passed: broad.citations.join() === 'quality-seed' && broad.results[0]?.weak_match === true
        && broad.results[0]?.lexical_match === 'partial_terms' && broad.results[0]?.lexical_coverage === 0.5
        && strict.results.length === 0 && strict.confidence === 0 && broad.answer === '' && strict.answer === '',
      details: { query: absentQuery, expected: [], broad_candidates: broad.citations, strict_candidates: strict.citations,
        broad_partial_candidates: broad.results.filter(hit => hit.weak_match).length,
        scope: 'The broad policy deliberately preserves a labelled weak candidate; neither response synthesizes an answer.' } });

    const verboseQuery = 'cache invalidation practical';
    const broadPositive = queryCorpus(db, { query: verboseQuery, lexical_policy: 'any', topK: 5 });
    const strictPositive = queryCorpus(db, { query: verboseQuery, lexical_policy: 'all', topK: 5 });
    results.push({ fixture_id: 'lexical-all-recall-tradeoff-visible', check: 'lexical_policy',
      passed: broadPositive.citations.some(id => id === 'quality-seed') && strictPositive.results.length === 0,
      details: { query: verboseQuery, relevant: ['quality-seed'], broad_candidates: broadPositive.citations,
        strict_candidates: strictPositive.citations, strict_missed_relevant: ['quality-seed'],
        scope: 'All-term matching can lose relevant sources when a question adds an unindexed modifier.' } });

    const nearHybrid = await queryHybridCorpus(db, { query: absentQuery, lexical_policy: 'all', topK: 5 }, embedder);
    const paraphrase = await queryHybridCorpus(db, { query: PARAPHRASE, lexical_policy: 'all', topK: 5 }, embedder);
    results.push({ fixture_id: 'hybrid-strict-lexical-semantic-independent', check: 'lexical_policy',
      passed: nearHybrid.retrieval_mode === 'hybrid' && nearHybrid.results.length === 0
        && paraphrase.retrieval_mode === 'hybrid' && paraphrase.citations.join() === 'quality-seed'
        && paraphrase.results.every(hit => hit.lexical_match === 'not_selected' && hit.lexical_coverage === null && hit.weak_match === null)
        && paraphrase.answer === '',
      details: { near_miss_returned: nearHybrid.citations, paraphrase_expected: ['quality-seed'], paraphrase_returned: paraphrase.citations,
        scope: 'No selected lexical candidate does not prove no lexical overlap in an arbitrary corpus.' } });

    const fallback = await queryHybridCorpus(db, { query: absentQuery, lexical_policy: 'all', topK: 5 }, null);
    results.push({ fixture_id: 'hybrid-fallback-preserves-lexical-policy', check: 'lexical_policy',
      passed: fallback.retrieval_mode === 'fts' && fallback.fallback_reason === 'embeddings_unavailable'
        && fallback.lexical_policy === 'all' && fallback.results.length === 0,
      details: { retrieval_mode: fallback.retrieval_mode, fallback_reason: fallback.fallback_reason,
        lexical_policy: fallback.lexical_policy, returned: fallback.citations } });

    const graph = await queryGraphCorpus(db, { query: 'cache invalidation', lexical_policy: 'all', topK: 5 }, embedder);
    const graphHits = graph.results.filter(hit => hit.retrieval_origin === 'graph');
    const expected = ['quality-contradiction', 'quality-support'];
    results.push({ fixture_id: 'graph-supported-and-conflicting-context', check: 'graph_retrieval',
      passed: graph.retrieval_mode === 'hybrid+graph' && graph.results[0]?.item_id === 'quality-seed'
        && graphHits.length === 2 && expected.every(id => graphHits.some(hit => hit.item_id === id))
        && graphHits.every(hit => hit.graph?.seed_item_id === 'quality-seed'
          && hit.graph.relationship_verification === 'unverified'
          && hit.graph.evidence_verification === 'exact_quotes_in_current_sources')
        && graphHits.some(hit => hit.graph?.relation_type === 'supports' && hit.graph.direction === 'incoming')
        && graphHits.some(hit => hit.graph?.relation_type === 'contradicts' && hit.graph.direction === 'outgoing')
        && graph.answer === '' && graph.confidence === null,
      details: { expected_graph_context: expected, returned: graph.citations,
        graph_relations: graphHits.map(hit => ({ item_id: hit.item_id, type: hit.graph?.relation_type, direction: hit.graph?.direction })),
        scope: 'Canned relations demonstrate context discovery and provenance; the semantic interpretation remains unverified.' } });

    const weakGraph = await queryGraphCorpus(db, { query: absentQuery, lexical_policy: 'any', topK: 5 }, embedder);
    // Remove the useful edges so invalid neighbors cannot hide behind a full graph budget.
    db.prepare('DELETE FROM relationships WHERE id IN (?, ?)').run('quality-support-edge', 'quality-contradiction-edge');
    const noiseOnly = await queryGraphCorpus(db, { query: 'cache invalidation', lexical_policy: 'all', topK: 5 }, embedder);
    results.push({ fixture_id: 'graph-weak-seed-and-edge-noise-contained', check: 'graph_retrieval',
      passed: !graph.citations.includes('quality-noise') && !graph.citations.includes('quality-second-hop')
        && weakGraph.citations.join() === 'quality-seed' && weakGraph.results.every(hit => hit.retrieval_origin === 'direct')
        && noiseOnly.citations.join() === 'quality-seed' && noiseOnly.results.every(hit => hit.retrieval_origin === 'direct'),
      details: { forbidden: ['quality-noise', 'quality-second-hop'], strong_seed_returned: graph.citations,
        weak_seed_returned: weakGraph.citations, invalid_edges_only_returned: noiseOnly.citations,
        scope: 'Partial lexical-only seeds do not expand; heuristic, invalid-quotation, and second-hop neighbors stay out.' } });
    return results;
  } finally { db.close(); }
}
