import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openMemoryDatabase, type Database } from '../db/connection.js';
import { backfillEmbeddings } from '../../scripts/backfill-embeddings.js';
import { queryCorpus } from './corpus-query.js';
import { queryHybridCorpus } from './hybrid-query.js';
import { ItemStore } from './item-store.js';
import { EMBEDDING_DIMENSIONS, disableVectorIndex, embeddingHash, embeddingText,
  validateVector, vectorIndexAvailable, vectorNeighbors, type Embedding } from './embeddings.js';
import type { Analysis, ExtractedSource } from './types.js';

const MODEL = 'test/lifecycle-embedding';
const NEXT_MODEL = 'test/next-lifecycle-embedding';
const TITLE = 'Cache maintenance';

function vector(axis = 0) {
  const values = Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  values[axis] = 1;
  return values;
}

function analysis(summary = 'Original cache policy.', axis = 0, model = MODEL): Analysis {
  const result: Analysis = {
    summary, claims: ['Invalidate dependencies before recomputing.'],
    reason: 'Relevant to maintenance.', relevance: { score: 0.8, themes: ['caching'] },
    recommended_action: 'save', confidence: 0.8, tags: [], relationships: [],
    model: 'test-analysis', analysis_version: 'lifecycle-v1'
  };
  result.embedding = { model, vector: vector(axis), inputHash: embeddingHash(embeddingText(TITLE, result)) };
  return result;
}

async function fixture() {
  const db = openMemoryDatabase();
  assert.equal(vectorIndexAvailable(db), true, 'exercise the actual derived vector index');
  const store = new ItemStore(db);
  const source: ExtractedSource = {
    sourceType: 'text', sourceUri: null, canonicalUrl: null, finalUrl: null,
    title: TITLE, extractedText: 'Cache dependency tracking preserves freshness.',
    truncated: false, contentHash: 'sha256:embedding-lifecycle', rawBytesHash: null, provenance: {}
  };
  const input = { principal: 'local', requestId: randomUUID(), payloadHash: source.contentHash,
    source, analyze: async () => analysis() };
  const result = await store.ingest(input);
  return { db, store, input, itemId: result.item_id };
}

function canonicalEmbedding(db: Database, itemId: string) {
  return db.prepare('SELECT analysis_id, model, input_hash, embedding FROM item_embeddings WHERE item_id = ?')
    .get(itemId) as { analysis_id: string; model: string; input_hash: string; embedding: Uint8Array } | undefined;
}

function assertEmbeddingRemoved(db: Database, itemId: string) {
  assert.equal(canonicalEmbedding(db, itemId), undefined, 'canonical vector must be removed');
  assert.equal(db.prepare('SELECT 1 FROM item_vec WHERE item_id = ?').get(itemId), undefined,
    'derived vector bytes must be removed');
}

test('reanalysis replaces the canonical and derived vectors for the latest analysis and replays once', async t => {
  const { db, store, itemId } = await fixture();
  t.after(() => db.close());
  const original = canonicalEmbedding(db, itemId)!;
  const revised = analysis('Revised dependency policy.', 1);
  let calls = 0;
  const operation = { principal: 'local', requestId: randomUUID(), itemId,
    analyze: async () => { calls++; return revised; } };

  assert.equal((await store.reanalyze(operation)).dedupe_status, 'reanalyzed');
  const saved = canonicalEmbedding(db, itemId)!;
  assert.notEqual(saved.analysis_id, original.analysis_id);
  assert.equal(saved.analysis_id, db.prepare('SELECT id FROM analyses WHERE item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(itemId)?.id);
  assert.equal(saved.model, MODEL);
  assert.equal(saved.input_hash, revised.embedding?.inputHash);
  assert.deepEqual(saved.embedding, validateVector(vector(1)));
  assert.equal(db.prepare('SELECT count(*) AS n FROM item_vec WHERE item_id = ?').get(itemId)?.n, 1);
  assert.ok(Math.abs(vectorNeighbors(db, vector(1), MODEL)[0]!.distance) < 0.00001);
  assert.ok(Math.abs(vectorNeighbors(db, vector(), MODEL)[0]!.distance - 1) < 0.00001);

  assert.equal((await store.reanalyze(operation)).dedupe_status, 'idempotent_replay');
  assert.equal(calls, 1);
  assert.deepEqual(canonicalEmbedding(db, itemId), saved);
  assert.equal(db.prepare('SELECT count(*) AS n FROM analyses WHERE item_id = ?').get(itemId)?.n, 2);
});

test('successful reanalysis clears the old vector when its replacement is absent or invalid', async t => {
  for (const replacement of [null, { model: MODEL, vector: [1, 2], inputHash: 'invalid' }] satisfies Array<Embedding | null>) {
    await t.test(replacement ? 'invalid replacement' : 'absent replacement', async t => {
      const { db, store, itemId } = await fixture();
      t.after(() => db.close());
      const result = await store.reanalyze({ principal: 'local', requestId: randomUUID(), itemId,
        analyze: async () => ({ ...analysis('New zebracontext judgment.'), embedding: replacement }) });

      assert.equal(result.dedupe_status, 'reanalyzed');
      assert.equal(result.status, 'indexed');
      assertEmbeddingRemoved(db, itemId);
      assert.deepEqual(vectorNeighbors(db, vector(), MODEL), []);
      assert.deepEqual(queryCorpus(db, { query: 'zebracontext' }).citations, [itemId]);
      assert.equal(db.prepare('SELECT count(*) AS n FROM analyses WHERE item_id = ?').get(itemId)?.n, 2);
    });
  }
});

test('a later reanalysis persistence failure rolls back both vector replacements with the analysis', async t => {
  const { db, store, itemId } = await fixture();
  t.after(() => db.close());
  const before = canonicalEmbedding(db, itemId)!;
  const operation = { principal: 'local', requestId: randomUUID(), itemId };
  await assert.rejects(store.reanalyze({ ...operation, analyze: async () => ({ ...analysis('Invalid relationship.', 1),
    relationships: [{ from_item_id: itemId, to_item_id: 'missing', relation_type: 'extends',
      confidence: 0.8, explanation: 'Invalid foreign key.', origin: 'model' }] }) }), /FOREIGN KEY/);

  assert.deepEqual(canonicalEmbedding(db, itemId), before);
  assert.deepEqual(db.prepare('SELECT embedding FROM item_vec WHERE item_id = ?').get(itemId)?.embedding, before.embedding);
  assert.equal(db.prepare('SELECT count(*) AS n FROM analyses WHERE item_id = ?').get(itemId)?.n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM analysis_jobs').get()?.n, 0);
  assert.ok(Math.abs(vectorNeighbors(db, vector(), MODEL)[0]!.distance) < 0.00001);
  assert.equal((await store.reanalyze({ ...operation, analyze: async () => analysis('Valid retry.', 1) })).dedupe_status, 'reanalyzed');
});

test('forget removes canonical and derived vectors even while semantic retrieval is disabled', async t => {
  for (const disabled of [false, true]) {
    await t.test(disabled ? 'disabled index' : 'available index', async t => {
      const { db, store, itemId } = await fixture();
      t.after(() => db.close());
      if (disabled) disableVectorIndex(db);

      assert.equal(store.forget({ principal: 'local', itemId }).deleted, true);
      assertEmbeddingRemoved(db, itemId);
      assert.equal(db.prepare('SELECT 1 FROM items WHERE id = ?').get(itemId), undefined);
      const result = await queryHybridCorpus(db, { query: 'cache dependency' }, { model: MODEL, embed: async () => vector() });
      assert.deepEqual(result.citations, []);
    });
  }
});

test('duplicate ingestion retains lexical neighbors when its optional vector is malformed', async t => {
  for (const disabled of [false, true]) {
    await t.test(disabled ? 'disabled index' : 'available index', async t => {
      const { db, store, input, itemId } = await fixture();
      t.after(() => db.close());
      const neighbor = await store.ingest({ ...input, requestId: randomUUID(), payloadHash: 'neighbor',
        source: { ...input.source, contentHash: 'sha256:lexical-neighbor' } });
      db.prepare('UPDATE item_embeddings SET embedding = ? WHERE item_id = ?').run(new Uint8Array([1, 2, 3]), itemId);
      if (disabled) disableVectorIndex(db);

      const result = await store.ingest({ ...input, requestId: randomUUID(),
        analyze: async () => { assert.fail('duplicate content must not repeat analysis'); } });

      assert.equal(result.status, 'indexed');
      assert.equal(result.dedupe_status, 'existing');
      assert.deepEqual(result.related_items.map(hit => hit.item_id), [neighbor.item_id]);
      assert.match(result.related_items[0]!.match_reason, /Matched stored reading/);
      assert.ok(queryCorpus(db, { query: 'cache maintenance' }).citations.some(id => id === itemId));
    });
  }
});

test('backfill completion cannot replace a reanalysis vector or resurrect a forgotten item', async t => {
  for (const change of ['reanalyze', 'forget'] as const) {
    await t.test(change, async t => {
      const { db, store, input, itemId } = await fixture();
      t.after(() => db.close());
      let release!: (values: number[]) => void;
      let started!: () => void;
      const entered = new Promise<void>(resolve => { started = resolve; });
      const pending = backfillEmbeddings(db, { model: NEXT_MODEL, embed: async () => {
        started();
        return new Promise<number[]>(resolve => { release = resolve; });
      } }, { apply: true, limit: 1 });
      await entered;

      let replacementItemId = itemId;
      if (change === 'reanalyze') {
        await store.reanalyze({ principal: 'local', requestId: randomUUID(), itemId,
          analyze: async () => analysis('Latest dependency policy.', 1, NEXT_MODEL) });
      } else {
        store.forget({ principal: 'local', itemId });
        assertEmbeddingRemoved(db, itemId);
        const recaptured = await store.ingest({ ...input, requestId: randomUUID(),
          analyze: async () => analysis('Deliberately recaptured evidence.', 1, NEXT_MODEL) });
        replacementItemId = recaptured.item_id;
        assert.notEqual(replacementItemId, itemId);
      }
      const expected = canonicalEmbedding(db, replacementItemId)!;
      release(vector());

      const result = await pending;
      assert.deepEqual(result.outcomes, [{ item_id: itemId, status: 'changed_or_unavailable' }]);
      assert.deepEqual(canonicalEmbedding(db, replacementItemId), expected);
      const neighbors = vectorNeighbors(db, vector(1), NEXT_MODEL);
      assert.deepEqual(neighbors.map(hit => hit.item_id), [replacementItemId]);
      assert.ok(Math.abs(neighbors[0]!.distance) < 0.00001);
      if (change === 'forget') {
        assertEmbeddingRemoved(db, itemId);
        assert.equal(db.prepare('SELECT 1 FROM items WHERE id = ?').get(itemId), undefined);
      }
    });
  }
});
