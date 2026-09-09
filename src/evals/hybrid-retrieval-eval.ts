import { openMemoryDatabase, rebuildItemFts, transaction, type Database } from '../db/connection.js';
import { queryCorpus } from '../reading/corpus-query.js';
import { EMBEDDING_DIMENSIONS, embeddingHash, saveEmbedding, type Embedder } from '../reading/embeddings.js';
import { queryHybridCorpus } from '../reading/hybrid-query.js';
import type { ReadingMemoryEvalResult } from './reading-memory-eval.js';

const MODEL = 'synthetic/canned-1536';
const PARAPHRASE = 'purging obsolete memoized answers';
const HARD_NEGATIVE = 'photovoltaic silicon manufacturing';
const CURRENT_DATE = '2026-09-09T12:00:00.000Z';

function axis(index: number) {
  const vector = Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[index] = 1;
  return vector;
}

function nearby(similarity: number) {
  const vector = axis(0);
  vector[0] = similarity;
  vector[1] = Math.sqrt(1 - similarity * similarity);
  return vector;
}

// Canned coordinates exercise SQLite storage, filtering and rank fusion. They
// do not measure an embedding provider's language understanding or quality.
const embedder: Embedder = { model: MODEL, embed: async (text) => {
  if (text === PARAPHRASE) return axis(0);
  if (text === HARD_NEGATIVE) return axis(1535);
  throw new Error('Unexpected synthetic embedding input');
} };

function seed(db: Database, id: string, text: string, vector: number[], options: {
  date?: string; tag?: string; status?: 'indexed' | 'failed'
} = {}) {
  const date = options.date ?? CURRENT_DATE;
  const analysisId = `analysis_${id}`;
  transaction(db, () => {
    db.prepare(`INSERT INTO items (id, source_type, title, ingested_at, content_hash, status, extracted_text)
      VALUES (?, 'text', ?, ?, ?, ?, ?)`)
      .run(id, 'Synthetic source', date, `sha256:synthetic-${id}`, options.status ?? 'indexed', text);
    db.prepare(`INSERT INTO analyses (id, item_id, summary, recommended_action, confidence, model, analysis_version, created_at)
      VALUES (?, ?, ?, 'save', 0.8, 'canned-analysis', 'synthetic-v1', ?)`)
      .run(analysisId, id, text, date);
    db.prepare('INSERT INTO tags (item_id, tag, reason, confidence) VALUES (?, ?, ?, 0.8)')
      .run(id, options.tag ?? 'systems', 'Synthetic filter label');
    saveEmbedding(db, id, analysisId, { model: MODEL, vector, inputHash: embeddingHash(text) });
    rebuildItemFts(db, id);
  });
}

export async function runHybridRetrievalEval(): Promise<ReadingMemoryEvalResult[]> {
  const db = openMemoryDatabase();
  try {
    seed(db, 'hybrid-current', 'Cache invalidation prevents stale computation.', nearby(0.95));
    seed(db, 'hybrid-old', 'Cache expiry keeps stored computations fresh.', nearby(0.9), { date: '2026-01-01T12:00:00.000Z' });
    seed(db, 'hybrid-other-tag', 'Client cache eviction refreshes stale responses.', nearby(0.85), { tag: 'mobile' });
    seed(db, 'hybrid-failed', 'Cache lifetimes control stale results.', nearby(0.99), { status: 'failed' });
    seed(db, 'hybrid-unrelated', 'Carrots add sweetness to soup recipes.', axis(1), { tag: 'cooking' });
    const lexical = queryCorpus(db, { query: PARAPHRASE, topK: 1 });
    const semantic = await queryHybridCorpus(db, { query: PARAPHRASE, topK: 1 }, embedder);
    const supported = semantic.retrieval_mode === 'hybrid' && semantic.fallback_reason === null;
    const semanticOnly = semantic.results.every((hit) => hit.matched_terms.length === 0 && /semantic/i.test(hit.match_reason));
    const results: ReadingMemoryEvalResult[] = [{
      fixture_id: 'hybrid-zero-overlap-paraphrase', check: 'hybrid_retrieval',
      passed: lexical.retrieval_mode === 'fts' && lexical.citations.length === 0 && supported
        && semantic.citations.length === 1 && semantic.citations[0] === 'hybrid-current'
        && semanticOnly && semantic.confidence === null && semantic.answer === '',
      details: { query: PARAPHRASE, expected: ['hybrid-current'], returned: semantic.citations,
        default_mode: lexical.retrieval_mode, default_fts_returned: lexical.citations,
        semantic_only_matches: semanticOnly, hybrid_exercised: supported,
        embedding_source: 'canned deterministic vectors', embedding_dimensions: EMBEDDING_DIMENSIONS }
    }];

    const negative = await queryHybridCorpus(db, { query: HARD_NEGATIVE, topK: 5 }, embedder);
    results.push({ fixture_id: 'hybrid-hard-negative-abstention', check: 'hybrid_retrieval',
      passed: negative.retrieval_mode === 'hybrid' && negative.fallback_reason === null
        && negative.results.length === 0 && negative.citations.length === 0 && negative.confidence === 0 && negative.answer === '',
      details: { query: HARD_NEGATIVE, expected: [], returned: negative.citations,
        unsupported_result_count: negative.results.length, unsupported_answer: negative.answer !== '',
        hybrid_exercised: negative.retrieval_mode === 'hybrid' && negative.fallback_reason === null }
    });

    const filtered = await queryHybridCorpus(db, { query: PARAPHRASE, topK: 5,
      since: '2026-09-01T00:00:00.000Z', tags: ['systems'] }, embedder);
    const excluded = ['hybrid-old', 'hybrid-other-tag', 'hybrid-failed', 'hybrid-unrelated'];
    results.push({ fixture_id: 'hybrid-date-tag-status-filters', check: 'hybrid_retrieval',
      passed: filtered.retrieval_mode === 'hybrid' && filtered.fallback_reason === null
        && filtered.citations.length === 1 && filtered.citations[0] === 'hybrid-current'
        && excluded.every((id) => !filtered.citations.some((returned) => returned === id)),
      details: { query: PARAPHRASE, expected: ['hybrid-current'], returned: filtered.citations,
        forbidden_hits: excluded.filter((id) => filtered.citations.some((returned) => returned === id)),
        filters: { since: '2026-09-01T00:00:00.000Z', tags: ['systems'], status: 'indexed' } }
    });
    return results;
  } finally { db.close(); }
}
