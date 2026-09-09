import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { configureDatabase, migrate, openDatabase, openMemoryDatabase, rebuildItemFts, transaction, type Database } from '../db/connection.js';
import { getItem, queryCorpus } from './corpus-query.js';
import { queryHybridCorpus } from './hybrid-query.js';
import { ItemStore } from './item-store.js';
import { backfillEmbeddings } from '../../scripts/backfill-embeddings.js';
import { buildReadingContext, READING_CONTEXT_LIMITS } from './reading-context.js';
import { EMBEDDING_DIMENSIONS, embedAnalysis, embeddingHash, embeddingHealth, embeddingText, rebuildVectorIndex,
  saveEmbedding, validateVector, vectorIndexAvailable, vectorNeighbors, type Embedder } from './embeddings.js';
import type { Analysis, ExtractedSource } from './types.js';

const MODEL = 'openai/test-embedding-1536';
const NOW = '2026-09-09T12:00:00.000Z';
function vector(axis = 0) { const values = Array<number>(EMBEDDING_DIMENSIONS).fill(0); values[axis] = 1; return values; }
function nearVector(cosine: number) { const values = vector(); values[0] = cosine; values[1] = Math.sqrt(1 - cosine * cosine); return values; }
const embedder: Embedder = { model: MODEL, embed: async () => vector() };
function analysis(summary = 'Cached computations need reliable expiry.'): Analysis {
  return { summary, claims: ['Invalidation preserves freshness.'], relevance: { score: 0.5, themes: ['systems'] },
    recommended_action: 'save', confidence: 0.6, reason: 'Useful prior evidence.', tags: [], relationships: [],
    model: 'fake-analysis-model', analysis_version: 'test-v1' };
}
function addAnalysis(db: Database, itemId: string, summary: string, id = `analysis_${itemId}`) {
  db.prepare(`INSERT INTO analyses(id, item_id, summary, recommended_action, confidence, model, analysis_version, created_at)
    VALUES (?, ?, ?, 'save', 0.6, 'fake-analysis-model', 'test-v1', ?)`).run(id, itemId, summary, NOW);
  return id;
}
function seed(db: Database, id: string, options: {
  text?: string; title?: string; summary?: string; tags?: string[]; date?: string;
  status?: 'indexed' | 'failed'; model?: string; vector?: number[] | null;
} = {}) {
  const title = options.title ?? id;
  const text = options.text ?? 'Stored article prose.';
  const summary = options.summary ?? text;
  db.prepare(`INSERT INTO items(id, source_type, title, ingested_at, content_hash, status, extracted_text)
    VALUES (?, 'text', ?, ?, ?, ?, ?)`).run(id, title, options.date ?? NOW, `sha256:${id}`, options.status ?? 'indexed', text);
  const analysisId = addAnalysis(db, id, summary);
  for (const tag of options.tags ?? []) db.prepare('INSERT INTO tags(item_id, tag, reason, confidence) VALUES (?, ?, ?, 0.5)').run(id, tag, 'fixture');
  saveEmbedding(db, id, analysisId, options.vector === null ? null : {
    model: options.model ?? MODEL, vector: options.vector ?? vector(), inputHash: embeddingHash(summary)
  });
  rebuildItemFts(db, id);
  return analysisId;
}
function assertNoVectors(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    assert.ok(!['embedding', 'embeddings', 'vector'].includes(key), `public response must not expose ${key}`);
    assert.ok(!(entry instanceof Uint8Array), 'public response must not contain canonical vector blobs');
    assertNoVectors(entry);
  }
}

test('real sqlite-vec stores and queries canonical 1536-dimensional float32 vectors', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  assert.equal(vectorIndexAvailable(db), true, 'exercise the actual extension, not a mocked vector search');
  seed(db, 'close', { vector: nearVector(0.9) });
  seed(db, 'orthogonal', { vector: vector(1535) });
  const saved = db.prepare('SELECT analysis_id, model, dimensions, embedding FROM item_embeddings WHERE item_id = ?').get('close') as
    { analysis_id: string; model: string; dimensions: number; embedding: Uint8Array };
  assert.equal(saved.analysis_id, 'analysis_close');
  assert.equal(saved.model, MODEL);
  assert.equal(saved.dimensions, 1536);
  assert.equal(saved.embedding.byteLength, 1536 * 4);
  const hits = vectorNeighbors(db, vector(), MODEL, { topK: 2 });
  assert.deepEqual(hits.map(hit => hit.item_id), ['close', 'orthogonal']);
  assert.ok(Math.abs(hits[0]!.distance - 0.1) < 0.00001);
  assert.ok(Math.abs(hits[1]!.distance - 1) < 0.00001);
});

test('hybrid recalls a zero-overlap paraphrase that FTS cannot find and excludes semantic hard negatives', async (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  seed(db, 'prior', { title: 'Cache maintenance', text: 'Invalidation prevents stale computation.', vector: nearVector(0.95) });
  seed(db, 'unrelated', { title: 'Soup recipes', text: 'Carrots taste delicious.', vector: vector(1) });
  const input = { query: 'purging obsolete memoized answers' };
  assert.deepEqual(queryCorpus(db, input).results, []);
  const result = await queryHybridCorpus(db, input, embedder);
  assert.equal(result.retrieval_mode, 'hybrid');
  assert.equal(result.fallback_reason, null);
  assert.deepEqual(result.citations, ['prior']);
  assert.equal(result.confidence, null);
  assert.equal(result.answer, '');
  assert.deepEqual(result.results[0]?.matched_terms, []);
  assert.match(result.results[0]?.match_reason ?? '', /semantic/i);
  assertNoVectors(result);
  assertNoVectors(getItem(db, 'prior'));
});

test('rank fusion deduplicates shared lexical/vector hits and respects requested result counts', async (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  seed(db, 'both', { text: 'Cache invalidation preserves freshness.', vector: nearVector(0.9) });
  seed(db, 'lexical', { text: 'Cache invalidation is expensive.', vector: vector(1) });
  seed(db, 'semantic', { text: 'Remove obsolete computations.', vector: vector() });
  const result = await queryHybridCorpus(db, { query: 'cache invalidation', topK: 2 }, embedder);
  assert.equal(result.results.length, 2);
  assert.equal(result.citations[0], 'both');
  assert.equal(new Set(result.citations).size, result.citations.length);
  assert.match(result.results[0]?.match_reason ?? '', /lexical.*semantic/i);
  assertNoVectors(result);
});

test('date, tags, status, latest analysis, model, and self-exclusion filter before the vector candidate limit', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  for (let i = 0; i < 35; i++) {
    const options = { tags: ['infra'], vector: vector() };
    switch (i % 5) {
      case 0: seed(db, `old-${i}`, { ...options, date: '2026-08-01' }); break;
      case 1: seed(db, `wrong-tag-${i}`, { ...options, tags: ['cooking'] }); break;
      case 2: seed(db, `failed-${i}`, { ...options, status: 'failed' }); break;
      case 3: seed(db, `model-${i}`, { ...options, model: 'openai/other-space' }); break;
      default: {
        seed(db, `stale-${i}`, options);
        // Equal timestamps still require the newer rowid's analysis.
        addAnalysis(db, `stale-${i}`, 'New evidence.', `new_analysis_${i}`);
      }
    }
  }
  seed(db, 'self', { tags: ['infra'], vector: vector() });
  seed(db, 'eligible', { tags: ['infra'], vector: nearVector(0.8) });
  const hits = vectorNeighbors(db, vector(), MODEL, { topK: 1, since: '2026-09-01', tags: ['infra'], excludeItemId: 'self' });
  assert.deepEqual(hits.map(hit => hit.item_id), ['eligible']);
  assert.ok(hits[0]!.distance > 0.1, 'closer ineligible rows did not exhaust the candidate budget');
});

test('hybrid falls back explicitly for unconfigured, absent, and model-mismatched embeddings', async (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  seed(db, 'lexical-only', { text: 'Cache invalidation prevents stale values.', vector: null });
  for (const provider of [null, embedder]) {
    const result = await queryHybridCorpus(db, { query: 'cache invalidation' }, provider);
    assert.equal(result.retrieval_mode, 'fts');
    assert.equal(result.requested_mode, 'hybrid');
    assert.ok(result.fallback_reason);
    assert.deepEqual(result.citations, ['lexical-only']);
  }
  seed(db, 'other-model', { text: 'Cache invalidation strategies.', model: 'openai/different-model' });
  const mismatch = await queryHybridCorpus(db, { query: 'cache invalidation' }, embedder);
  assert.equal(mismatch.retrieval_mode, 'fts');
  assert.ok(mismatch.fallback_reason);
  assert.ok(mismatch.citations.includes('lexical-only'));
});

test('missing extension and failed query embeddings preserve the lexical result', async (t) => {
  const withoutExtension = new DatabaseSync(':memory:');
  configureDatabase(withoutExtension);
  migrate(withoutExtension);
  t.after(() => withoutExtension.close());
  seed(withoutExtension, 'stored', { text: 'Cache invalidation strategies.' });
  assert.equal(vectorIndexAvailable(withoutExtension), false);
  const unavailable = await queryHybridCorpus(withoutExtension, { query: 'cache invalidation' }, {
    model: MODEL, embed: async () => { assert.fail('no provider call when sqlite-vec is unavailable'); }
  });
  assert.equal(unavailable.retrieval_mode, 'fts');
  assert.deepEqual(unavailable.citations, ['stored']);
  const db = openMemoryDatabase();
  t.after(() => db.close());
  seed(db, 'stored', { text: 'Cache invalidation strategies.' });
  for (const failing of [async () => { throw new Error('provider secret'); }, async () => [1, 2]]) {
    const result = await queryHybridCorpus(db, { query: 'cache invalidation' }, { model: MODEL, embed: failing });
    assert.equal(result.retrieval_mode, 'fts');
    assert.equal(result.fallback_reason, 'embedding_query_failed');
    assert.deepEqual(result.citations, ['stored']);
    assert.doesNotMatch(JSON.stringify(result), /provider secret/);
  }
});

test('validation rejects malformed and float32-zero vectors before persistence', () => {
  const tiny = vector().map(value => value * 1e-50);
  for (const invalid of [[], [1, 2], Array(1536).fill(0), [NaN, ...vector().slice(1)],
    [Infinity, ...vector().slice(1)], [Number.MAX_VALUE, ...vector().slice(1)], tiny]) {
    assert.throws(() => validateVector(invalid), /Invalid embedding vector/);
  }
  assert.equal(validateVector(vector()).byteLength, 6144);
});

test('accepted vector magnitudes cannot produce infinite or incorrect cosine distances', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  for (const scale of [1e-30, 1e30]) {
    const bytes = validateVector(vector().map(value => value * scale));
    const { distance } = db.prepare('SELECT vec_distance_cosine(?, ?) AS distance').get(validateVector(vector()), bytes) as { distance: number };
    assert.ok(Number.isFinite(distance), 'accepted inputs must yield finite cosine scores');
    assert.ok(Math.abs(distance) < 0.00001, 'magnitude must not change equivalent-direction similarity');
  }
});

test('embedding failures cannot turn a successful ingest into a failure or expose vectors', async (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  const store = new ItemStore(db);
  const source: ExtractedSource = { sourceType: 'text', sourceUri: null, canonicalUrl: null, finalUrl: null,
    title: 'Cache maintenance', extractedText: 'Cache invalidation preserves freshness.', truncated: false,
    contentHash: 'sha256:optional-embedding', rawBytesHash: null, provenance: {} };
  assert.equal(await embedAnalysis({ model: MODEL, embed: async () => { throw new Error('private provider failure'); } }, source.title, analysis()), null);
  assert.equal(await embedAnalysis({ model: MODEL, embed: async () => [1, 2] }, source.title, analysis()), null);
  const result = await store.ingest({ principal: 'test', requestId: 'optional-embedding-request', payloadHash: 'hash', source,
    analyze: async () => ({ ...analysis(), embedding: { model: MODEL, inputHash: 'invalid', vector: [1, 2] } }) });
  assert.equal(result.status, 'indexed');
  assert.deepEqual(queryCorpus(db, { query: 'cache invalidation' }).citations, [result.item_id]);
  assert.equal((db.prepare('SELECT count(*) AS count FROM item_embeddings').get() as { count: number }).count, 0);
  assertNoVectors(result);
  assertNoVectors(getItem(db, result.item_id));
  const snapshot = db.prepare('SELECT response_snapshot FROM idempotency_keys WHERE request_id = ?').get('optional-embedding-request') as { response_snapshot: string };
  assertNoVectors(JSON.parse(snapshot.response_snapshot));
  const validAnalysis = { ...analysis(), embedding: await embedAnalysis(embedder, source.title, analysis()) };
  const validInput = { principal: 'test', requestId: 'valid-embedding-request', payloadHash: 'valid-hash',
    source: { ...source, contentHash: 'sha256:valid-embedding' }, analyze: async () => validAnalysis };
  const validResult = await store.ingest(validInput);
  assert.equal(validResult.status, 'indexed');
  assert.equal((db.prepare('SELECT length(embedding) AS bytes FROM item_embeddings WHERE item_id = ?').get(validResult.item_id) as { bytes: number }).bytes, 6144);
  assertNoVectors(validResult);
  assertNoVectors(await store.ingest(validInput));
  assertNoVectors(getItem(db, validResult.item_id, { includeText: true }));
  const validSnapshot = db.prepare('SELECT response_snapshot FROM idempotency_keys WHERE request_id = ?').get('valid-embedding-request') as { response_snapshot: string };
  assertNoVectors(JSON.parse(validSnapshot.response_snapshot));
});

test('canonical vectors rebuild after restart while stale analyses and failed items remain excluded', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reading-memory-vectors-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'reading.sqlite');
  let db = openDatabase(path);
  seed(db, 'current', { vector: nearVector(0.9) });
  seed(db, 'stale');
  addAnalysis(db, 'stale', 'New unembedded analysis.', 'newest_stale');
  seed(db, 'failed', { status: 'failed' });
  seed(db, 'missing', { vector: null });
  db.exec('DELETE FROM item_vec');
  db.close();
  db = openDatabase(path);
  t.after(() => db.close());
  assert.equal(vectorIndexAvailable(db), true);
  assert.deepEqual(vectorNeighbors(db, vector(), MODEL).map(hit => hit.item_id), ['current']);
  assert.equal((db.prepare('SELECT count(*) AS count FROM item_embeddings').get() as { count: number }).count, 3);
  assert.equal(embeddingHealth(db, MODEL).missing_items, 2);
});

test('caller rollback removes canonical and derived writes, and failed rebuild rolls back its deletion', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  seed(db, 'original');
  assert.throws(() => transaction(db, () => {
    seed(db, 'rolled-back');
    throw new Error('rollback fixture');
  }), /rollback fixture/);
  assert.equal(db.prepare('SELECT 1 FROM item_embeddings WHERE item_id = ?').get('rolled-back'), undefined);
  assert.deepEqual(vectorNeighbors(db, vector(), MODEL).map(hit => hit.item_id), ['original']);
  seed(db, 'corrupt');
  db.prepare('UPDATE item_embeddings SET embedding = ? WHERE item_id = ?').run(new Uint8Array([1, 2, 3]), 'corrupt');
  assert.throws(() => rebuildVectorIndex(db));
  assert.equal((db.prepare('SELECT count(*) AS count FROM item_vec').get() as { count: number }).count, 2,
    'rebuild failure retains the previous derived index transactionally');
  assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
});

test('failed startup vector rebuild keeps the corpus usable through an explicit FTS fallback', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reading-memory-vector-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'reading.sqlite');
  let db = openDatabase(path);
  seed(db, 'recoverable', { text: 'Cache invalidation preserves freshness.' });
  db.prepare('UPDATE item_embeddings SET embedding = ?').run(new Uint8Array([1, 2, 3]));
  db.close();
  db = openDatabase(path);
  t.after(() => db.close());
  assert.equal(vectorIndexAvailable(db), false);
  assert.equal(embeddingHealth(db, MODEL).vector_index, 'unavailable');
  const result = await queryHybridCorpus(db, { query: 'cache invalidation' }, embedder);
  assert.equal(result.retrieval_mode, 'fts');
  assert.ok(result.fallback_reason);
  assert.deepEqual(result.citations, ['recoverable']);
  assert.ok(getItem(db, 'recoverable'));
});

test('embedding inputs and hashes use the bounded title/summary/claims projection', async () => {
  const summary = analysis();
  const text = embeddingText('Reader title', summary);
  assert.match(text, /^Reader title\nCached computations/);
  assert.match(text, /Invalidation preserves freshness/);
  assert.equal(embeddingText('Title', analysis('x'.repeat(20_000))).length, 16_000);
  const embedded = await embedAnalysis({ model: MODEL, embed: async input => { assert.equal(input, text); return vector(); } }, 'Reader title', summary);
  assert.equal(embedded?.inputHash, embeddingHash(text));
  assert.equal(embedded?.model, MODEL);
});


test('embedding backfill dry run never calls the provider or writes, and apply keeps provider failures indexed', async (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  seed(db, 'a-ready', { vector: null });
  seed(db, 'b-provider-failure', { vector: null });
  let calls = 0;
  const provider: Embedder = { model: MODEL, embed: async text => {
    calls++;
    if (text.startsWith('b-provider-failure')) throw new Error('private provider details');
    return vector();
  } };
  const before = db.prepare('SELECT total_changes() AS count').get()?.count;
  db.exec('PRAGMA query_only = ON');
  const preview = await backfillEmbeddings(db, provider);
  db.exec('PRAGMA query_only = OFF');
  assert.equal(preview.mode, 'dry-run');
  assert.deepEqual(preview.outcomes, [{ item_id: 'a-ready', status: 'would_embed' }, { item_id: 'b-provider-failure', status: 'would_embed' }]);
  assert.equal(calls, 0);
  assert.equal(db.prepare('SELECT total_changes() AS count').get()?.count, before);
  const result = await backfillEmbeddings(db, provider, { apply: true });
  assert.equal(result.mode, 'apply');
  assert.equal(calls, 2);
  assert.deepEqual(result.outcomes, [{ item_id: 'a-ready', status: 'embedded' }, { item_id: 'b-provider-failure', status: 'embedding_failed' }]);
  assert.deepEqual(vectorNeighbors(db, vector(), MODEL).map(hit => hit.item_id), ['a-ready']);
  assert.equal(db.prepare('SELECT status FROM items WHERE id = ?').get('b-provider-failure')?.status, 'indexed');
  assert.equal(db.prepare('SELECT count(*) AS count FROM analyses').get()?.count, 2);
  assert.doesNotMatch(JSON.stringify(result), /private provider details/);
});

test('backfill checks the latest analysis and item existence again after waiting for the provider', async (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  for (const change of ['reanalyzed', 'deleted'] as const) {
    // Only one pending item per maintenance invocation, making the race explicit.
    seed(db, change, { vector: null });
    let release!: (values: number[]) => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const pending = backfillEmbeddings(db, { model: MODEL, embed: async () => {
      started();
      return new Promise<number[]>(resolve => { release = resolve; });
    } }, { apply: true, limit: 1 });
    await entered;
    if (change === 'reanalyzed') addAnalysis(db, change, 'Updated evidence.', 'replacement_analysis');
    else db.prepare('DELETE FROM items WHERE id = ?').run(change);
    release(vector());
    const result = await pending;
    assert.deepEqual(result.outcomes, [{ item_id: change, status: 'changed_or_unavailable' }]);
    assert.equal(db.prepare('SELECT 1 FROM item_embeddings WHERE item_id = ?').get(change), undefined);
    assert.equal(db.prepare('SELECT 1 FROM item_vec WHERE item_id = ?').get(change), undefined);
    if (change === 'reanalyzed') {
      assert.equal(db.prepare('SELECT status FROM items WHERE id = ?').get(change)?.status, 'indexed');
      assert.equal(db.prepare('SELECT count(*) AS count FROM analyses WHERE item_id = ?').get(change)?.count, 2);
      // Remove this fixture before the next bounded maintenance invocation.
      db.prepare('DELETE FROM items WHERE id = ?').run(change);
    } else assert.equal(db.prepare('SELECT 1 FROM items WHERE id = ?').get(change), undefined);
  }
});

test('reading context accepts semantic-only prior IDs with verbatim bounded evidence and a five-item cap', (t) => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  const source = 'Cache invalidation prevents stale computation. '.repeat(100);
  for (let i = 0; i < 8; i++) seed(db, `prior-${i}`, { title: 'Cache maintenance', text: source });
  seed(db, 'current');
  seed(db, 'failed', { status: 'failed' });
  const input = { itemId: 'current', title: null, text: 'purging obsolete memoized answers' };
  assert.deepEqual(buildReadingContext(db, input).prior_items, [], 'the source shares no lexical terms with prior articles');
  const result = buildReadingContext(db, { ...input, priorItemIds: Array.from({ length: 8 }, (_, i) => `prior-${i}`) });
  assert.equal(result.prior_items.length, READING_CONTEXT_LIMITS.priorItems);
  assert.equal(result.prior_items.length, 5);
  assert.deepEqual(result.prior_items.map(item => item.item_id), ['prior-0', 'prior-1', 'prior-2', 'prior-3', 'prior-4']);
  for (const prior of result.prior_items) {
    assert.ok(prior.source_passages.length > 0 && prior.source_passages.length <= READING_CONTEXT_LIMITS.sourcePassages);
    for (const passage of prior.source_passages) {
      assert.ok(source.includes(passage));
      assert.ok(passage.length <= READING_CONTEXT_LIMITS.passageChars);
    }
  }
  const filtered = buildReadingContext(db, { ...input, priorItemIds: ['current', 'failed', 'missing', 'prior-0', 'prior-0'] });
  assert.deepEqual(filtered.prior_items.map(item => item.item_id), ['prior-0']);
  assertNoVectors(result);
});
