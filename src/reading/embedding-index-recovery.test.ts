import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../db/connection.js';
import { ItemStore } from './item-store.js';
import { queryCorpus } from './corpus-query.js';
import { queryHybridCorpus } from './hybrid-query.js';
import { embeddingHash, embeddingText, vectorIndexAvailable, vectorNeighbors } from './embeddings.js';
import type { Analysis, ExtractedSource } from './types.js';

const MODEL = 'test/embedding';
const TITLE = 'Stored private cache policy';
const vector = [1, ...Array<number>(1535).fill(0)];
function analysis(summary: string): Analysis {
  const result: Analysis = {
    summary, claims: ['Dependency tracking controls refresh.'],
    reason: 'Cache maintenance.', relevance: { score: 0.8, themes: ['cache'] },
    recommended_action: 'save', confidence: 0.8, tags: [], relationships: [],
    model: 'test', analysis_version: 'test'
  };
  result.embedding = { model: MODEL, vector, inputHash: embeddingHash(embeddingText(TITLE, result)) };
  return result;
}

async function damagedFixture(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'reading-vector-recovery-'));
  const path = join(directory, 'reading.sqlite');
  let db = openDatabase(path);
  const source: ExtractedSource = {
    sourceType: 'text', sourceUri: null, canonicalUrl: null, finalUrl: null,
    title: TITLE, extractedText: 'Cache dependencies preserve source freshness.',
    truncated: false, contentHash: 'sha256:damaged-optional-index', rawBytesHash: null, provenance: {}
  };
  const result = await new ItemStore(db).ingest({ principal: 'local', requestId: randomUUID(), payloadHash: 'hash',
    source, analyze: async () => analysis('Private original cache judgment.') });
  assert.equal(vectorIndexAvailable(db), true);
  db.exec('DELETE FROM item_vec_vector_chunks00');
  db.close();
  db = openDatabase(path);
  assert.equal(vectorIndexAvailable(db), false, 'startup detects damaged optional index');
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { db, itemId: result.item_id, reopen() { db.close(); db = openDatabase(path); return db; } };
}

test('a damaged optional index cannot prevent successful canonical reanalysis', async t => {
  for (const withEmbedding of [false, true]) {
    await t.test(withEmbedding ? 'new canonical embedding' : 'missing replacement embedding', async t => {
      const { db, itemId, reopen } = await damagedFixture(t);
      const revised = analysis('Updated zebracontext maintenance judgment.');
      const result = await new ItemStore(db).reanalyze({ principal: 'local', requestId: randomUUID(), itemId,
        analyze: async () => ({ ...revised, embedding: withEmbedding ? revised.embedding! : null }) });
      assert.equal(result.dedupe_status, 'reanalyzed');
      assert.equal(result.summary, revised.summary);
      assert.equal(db.prepare('SELECT count(*) AS n FROM analyses WHERE item_id = ?').get(itemId)?.n, 2);
      assert.equal(Boolean(db.prepare('SELECT 1 FROM item_embeddings WHERE item_id = ?').get(itemId)), withEmbedding);
      assert.deepEqual(queryCorpus(db, { query: 'zebracontext' }).citations, [itemId]);
      assert.equal(vectorIndexAvailable(db), false);
      assert.deepEqual(vectorNeighbors(db, vector, MODEL), []);

      const restarted = reopen();
      assert.deepEqual(queryCorpus(restarted, { query: 'zebracontext' }).citations, [itemId]);
      const hybrid = await queryHybridCorpus(restarted, { query: 'zebracontext' }, { model: MODEL, embed: async () => vector });
      assert.deepEqual(hybrid.citations, [itemId]);
      assert.equal(hybrid.retrieval_mode, 'fts');
      assert.equal(hybrid.fallback_reason, 'embeddings_unavailable');
    });
  }
});

test('forget succeeds with a damaged derived vector index and cannot resurface its content after restart', async t => {
  const { db, itemId, reopen } = await damagedFixture(t);
  assert.deepEqual(new ItemStore(db).forget({ principal: 'local', itemId }), { item_id: itemId, deleted: true });
  assert.equal(db.prepare('SELECT 1 FROM items WHERE id = ?').get(itemId), undefined);
  assert.equal(db.prepare('SELECT 1 FROM item_embeddings WHERE item_id = ?').get(itemId), undefined);
  assert.deepEqual(vectorNeighbors(db, vector, MODEL), []);
  const restarted = reopen();
  assert.deepEqual(queryCorpus(restarted, { query: 'cache' }).citations, []);
  const hybrid = await queryHybridCorpus(restarted, { query: 'cache' }, { model: MODEL, embed: async () => vector });
  assert.deepEqual(hybrid.results, []);
  assert.deepEqual(hybrid.citations, []);
  assert.equal(JSON.stringify(hybrid).includes(itemId), false);
  assert.equal(JSON.stringify(hybrid).includes(TITLE), false);
});
