import type { Database } from '../db/connection.js';
import type { Embedder } from './embeddings.js';
import { queryHybridCorpus } from './hybrid-query.js';
import { sourceFamilyResolver, type SourceFamily } from './source-families.js';
import { GRAPH_CANDIDATE_WHERE, GRAPH_QUOTE_CHECKS, graphEvidence } from './graph-eligibility.js';

const MAX_SEEDS = 3;
const MAX_GRAPH_RESULTS = 2;
const EDGE_SCAN_LIMIT = 100;
const HINT = 'One-hop graph expansion preserves rank order among distinct source families and adds up to two related sources. Repeated source families are suppressed within the bounded candidate pool; family identity does not prove independent corroboration. Graph order and model confidence are not answer confidence. Exact quotations verify that passages exist in current sources, not that the proposed relationship is true. Inspect both sources before making claims.';

type BaseHit = Awaited<ReturnType<typeof queryHybridCorpus>>['results'][number];
type EdgeRow = {
  id: string; from_item_id: string; to_item_id: string; relation_type: string;
  explanation: string; confidence: number; evidence_json: string | null;
  source_quote_exists: number; target_quote_exists: number;
  item_id: string; title: string | null; source_uri: string | null;
};

function eligibleSeed(hit: BaseHit, terms: string[]) {
  const vector = 'cosine_distance' in hit && typeof hit.cosine_distance === 'number'
    && Number.isFinite(hit.cosine_distance) && hit.cosine_distance <= 0.5
    && 'vector_rank' in hit && hit.vector_rank !== null;
  return vector || (terms.length > 0 && terms.every(term => hit.matched_terms.includes(term)));
}

/** All graph reads happen synchronously after hybrid's provider await, using current corpus state. */
export async function queryGraphCorpus(db: Database, input: Parameters<typeof queryHybridCorpus>[1], embedder: Embedder | null) {
  const topK = Math.max(1, Math.min(25, input.topK ?? 10));
  const base = await queryHybridCorpus(db, { ...input, topK: 25 }, embedder);
  const graphBudget = Math.min(MAX_GRAPH_RESULTS, Math.floor(topK / 2));
  const directCount = topK - graphBudget;
  const familyFor = sourceFamilyResolver(db, input);
  const familyIds = new Set<string>();
  const suppressedDirect = new Set<string>();
  const distinctBase = base.results.filter(hit => {
    const family = familyFor(hit.item_id);
    if (familyIds.has(family.id)) { suppressedDirect.add(hit.item_id); return false; }
    familyIds.add(family.id);
    return true;
  });
  const retained = distinctBase.slice(0, directCount);
  const representedFamilies = new Set(retained.map(hit => familyFor(hit.item_id).id));
  const seeds = graphBudget ? retained.filter(hit => eligibleSeed(hit, base.search_terms)).slice(0, MAX_SEEDS) : [];
  const seen = new Set(retained.map(hit => hit.item_id));
  const directRanks = new Map(base.results.map((hit, index) => [hit.item_id, index + 1]));
  const tags = input.tags ?? [];
  const findEdges = db.prepare(`WITH selected_edges AS MATERIALIZED (
    SELECT r.id, r.from_item_id, r.to_item_id, r.relation_type,
      r.explanation, r.confidence, r.evidence_json,
      peer.id AS item_id, peer.title, peer.source_uri
    FROM relationships r
    JOIN items src ON src.id = r.from_item_id AND src.status = 'indexed'
    JOIN items dst ON dst.id = r.to_item_id AND dst.status = 'indexed'
    JOIN items peer ON peer.id = CASE WHEN r.from_item_id = ? THEN r.to_item_id ELSE r.from_item_id END
    WHERE (r.from_item_id = ? OR r.to_item_id = ?) AND ${GRAPH_CANDIDATE_WHERE}
      AND (? IS NULL OR peer.ingested_at >= ?)
      AND (? = 0 OR EXISTS (SELECT 1 FROM tags t WHERE t.item_id = peer.id AND t.tag IN (${tags.map(() => '?').join(',') || "''"})))
    ORDER BY r.id ASC LIMIT ?)
    SELECT e.*,
      ${GRAPH_QUOTE_CHECKS}
    FROM selected_edges e JOIN items src ON src.id = e.from_item_id JOIN items dst ON dst.id = e.to_item_id
    ORDER BY e.id ASC`);
  type GraphHit = {
    item_id: string; title: string | null; source_uri: string | null; snippet: string; score: null;
    matched_terms: string[]; match_reason: string; retrieval_origin: 'graph'; direct_rank: number | null;
    lexical_match: 'all_terms' | 'partial_terms' | 'not_selected'; lexical_coverage: number | null; weak_match: boolean | null;
    source_family: SourceFamily;
    graph: { seed_item_id: string; relationship_id: string; origin: 'model'; from_item_id: string; to_item_id: string;
      direction: 'outgoing' | 'incoming'; relation_type: string; explanation: string; model_confidence: number;
      evidence: { source_quote: string; target_quote: string }; relationship_verification: 'unverified';
      evidence_verification: 'exact_quotes_in_current_sources' };
  };
  const graphHits: GraphHit[] = [];
  const suppressedGraph = new Set<string>();
  let consideredEdges = 0;
  let scanTruncated = false;
  const visitedSeeds: string[] = [];
  for (const seed of seeds) {
    if (graphHits.length >= graphBudget) break;
    visitedSeeds.push(seed.item_id);
    // One extra row only detects truncation; at most 100 rows per seed are validated.
    const edges = findEdges.all(seed.item_id, seed.item_id, seed.item_id,
      input.since ?? null, input.since ?? null, tags.length, ...tags, EDGE_SCAN_LIMIT + 1) as EdgeRow[];
    scanTruncated ||= edges.length > EDGE_SCAN_LIMIT;
    for (const edge of edges.slice(0, EDGE_SCAN_LIMIT)) {
      if (graphHits.length >= graphBudget) break;
      consideredEdges++;
      if (seen.has(edge.item_id)) continue;
      const evidence = graphEvidence(edge);
      if (!evidence) continue;
      const family = familyFor(edge.item_id);
      if (representedFamilies.has(family.id)) { suppressedGraph.add(edge.item_id); continue; }
      const outgoing = edge.from_item_id === seed.item_id;
      const existing = base.results.find(hit => hit.item_id === edge.item_id);
      const matchedTerms = existing?.matched_terms ?? [];
      const coverage = matchedTerms.length && base.search_terms.length ? matchedTerms.length / base.search_terms.length : null;
      seen.add(edge.item_id);
      representedFamilies.add(family.id);
      graphHits.push({ item_id: edge.item_id, title: edge.title, source_uri: edge.source_uri,
        snippet: outgoing ? evidence.target_quote : evidence.source_quote, score: null,
        matched_terms: matchedTerms, lexical_match: coverage === null ? 'not_selected' : coverage === 1 ? 'all_terms' : 'partial_terms',
        lexical_coverage: coverage, weak_match: coverage === null ? null : coverage < 1,
        match_reason: 'Related through a quoted model-proposed relationship; this is not a direct query relevance or answer-support judgment.',
        source_family: family, retrieval_origin: 'graph', direct_rank: directRanks.get(edge.item_id) ?? null,
        graph: { seed_item_id: seed.item_id, relationship_id: edge.id, origin: 'model', from_item_id: edge.from_item_id,
          to_item_id: edge.to_item_id, direction: outgoing ? 'outgoing' : 'incoming',
          relation_type: edge.relation_type, explanation: edge.explanation, model_confidence: edge.confidence,
          evidence, relationship_verification: 'unverified', evidence_verification: 'exact_quotes_in_current_sources' }
      });
    }
  }
  const direct = (hit: BaseHit) => ({ ...hit, retrieval_origin: 'direct' as const,
    source_family: familyFor(hit.item_id), direct_rank: directRanks.get(hit.item_id)!, graph: null });
  const results = [...retained.map(direct), ...graphHits];
  for (const hit of distinctBase.slice(retained.length)) {
    if (results.length >= topK) break;
    if (seen.has(hit.item_id)) continue;
    const family = familyFor(hit.item_id);
    if (representedFamilies.has(family.id)) { suppressedDirect.add(hit.item_id); continue; }
    representedFamilies.add(family.id);
    results.push(direct(hit));
  }
  return { ...base, results, citations: results.map(hit => hit.item_id),
    requested_mode: 'hybrid+graph' as const,
    retrieval_mode: base.retrieval_mode === 'hybrid' ? 'hybrid+graph' as const : 'fts+graph' as const,
    base_retrieval_mode: base.retrieval_mode, retrieval_hint: `${base.retrieval_hint} ${HINT}`,
    graph_expansion: { hops: 1, max_seeds: MAX_SEEDS, max_graph_results: graphBudget,
      edge_scan_limit_per_seed: EDGE_SCAN_LIMIT, seed_item_ids: visitedSeeds,
      family_policy: 'distinct_sources' as const, base_candidate_limit: 25,
      suppressed_direct_family_candidates: suppressedDirect.size,
      suppressed_graph_family_candidates: suppressedGraph.size,
      considered_edges: consideredEdges, scan_truncated: scanTruncated, added_results: graphHits.length }
  };
}
