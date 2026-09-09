import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, openMemoryDatabase } from '../db/connection.js';
import { ItemStore } from './item-store.js';
import { queryCorpus } from './corpus-query.js';
import { queryHybridCorpus } from './hybrid-query.js';
import { embeddingHash, embeddingHealth, embeddingText, validateVector, vectorIndexAvailable, vectorNeighbors } from './embeddings.js';
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

async function damagedFixture(t: import('node:test').TestContext, reopenAfterDamage = true) {
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
  if (reopenAfterDamage) {
    db.close();
    db = openDatabase(path);
    assert.equal(vectorIndexAvailable(db), false, 'startup detects damaged optional index');
  }
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { db, source, itemId: result.item_id, reopen() { db.close(); db = openDatabase(path); return db; } };
}

for (const operation of ['ingest', 'reanalyze'] as const) {
  test(`${operation} keeps the canonical vector when a damaged derived index rejects insertion`, async t => {
    const { db, source, reopen } = await damagedFixture(t, false);
    const store = new ItemStore(db);
    const input = { principal: 'local', requestId: randomUUID(), payloadHash: 'new-source',
      source: { ...source, contentHash: 'sha256:derived-insert-failure' } };
    const existing = operation === 'reanalyze'
      ? await store.ingest({ ...input, analyze: async () => ({ ...analysis('Unembedded prior judgment.'), embedding: null }) })
      : null;
    assert.equal(vectorIndexAvailable(db), true, 'damage has not been encountered by a managed write yet');
    const revised = analysis('Updated zebracontext canonical judgment.');
    const result = existing
      ? await store.reanalyze({ principal: 'local', requestId: randomUUID(), itemId: existing.item_id, analyze: async () => revised })
      : await store.ingest({ ...input, analyze: async () => revised });

    assert.equal(result.status, 'indexed');
    assert.equal(result.summary, revised.summary);
    assert.equal(vectorIndexAvailable(db), false, 'a failed derived insert disables further vector work');
    const canonical = db.prepare('SELECT analysis_id, input_hash, embedding FROM item_embeddings WHERE item_id = ?').get(result.item_id)!;
    assert.equal(canonical.analysis_id, db.prepare('SELECT id FROM analyses WHERE item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(result.item_id)?.id);
    assert.equal(canonical.input_hash, revised.embedding!.inputHash);
    assert.deepEqual(canonical.embedding, validateVector(vector));
    // sqlite-vec creates its rowid before opening the missing chunk blob. Only
    // the derived savepoint rollback removes that partial insertion.
    assert.equal(db.prepare('SELECT 1 FROM item_vec_rowids WHERE id = ?').get(result.item_id), undefined);
    assert.deepEqual(queryCorpus(db, { query: 'zebracontext' }).citations, [result.item_id]);

    const next = await store.ingest({ ...input, requestId: randomUUID(), payloadHash: 'subsequent-source',
      source: { ...source, contentHash: 'sha256:subsequent-canonical-vector' }, analyze: async () => analysis('Later canonical judgment.') });
    assert.ok(db.prepare('SELECT 1 FROM item_embeddings WHERE item_id = ?').get(next.item_id));
    assert.equal(db.prepare('SELECT 1 FROM item_vec_rowids WHERE id = ?').get(next.item_id), undefined);
    assert.equal(embeddingHealth(db, MODEL).missing_items, 0, 'valid provider results remain canonical for rebuilding');

    const restarted = reopen();
    assert.deepEqual(restarted.prepare('SELECT analysis_id, input_hash, embedding FROM item_embeddings WHERE item_id = ?').get(result.item_id), canonical);
    assert.ok(restarted.prepare('SELECT 1 FROM item_embeddings WHERE item_id = ?').get(next.item_id));
    assert.equal(restarted.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  });
}

test('a later analysis transaction failure still rolls back a canonical vector retained after derived insert failure', async t => {
  const { db, source } = await damagedFixture(t, false);
  const store = new ItemStore(db);
  const existing = await store.ingest({ principal: 'local', requestId: randomUUID(), payloadHash: 'unembedded-source',
    source: { ...source, contentHash: 'sha256:caller-rollback' },
    analyze: async () => ({ ...analysis('Original retained judgment.'), embedding: null }) });
  const original = db.prepare('SELECT * FROM analyses WHERE item_id = ?').all(existing.item_id);
  await assert.rejects(store.reanalyze({ principal: 'local', requestId: randomUUID(), itemId: existing.item_id,
    analyze: async () => ({ ...analysis('Must roll back.'), relationships: [{ from_item_id: existing.item_id,
      to_item_id: 'missing-item', relation_type: 'supports', explanation: 'Invalid foreign key.', confidence: 0.8 }] }) }), /FOREIGN KEY/);
  assert.deepEqual(db.prepare('SELECT * FROM analyses WHERE item_id = ?').all(existing.item_id), original);
  assert.equal(db.prepare('SELECT 1 FROM item_embeddings WHERE item_id = ?').get(existing.item_id), undefined);
  assert.equal(db.prepare('SELECT 1 FROM item_vec_rowids WHERE id = ?').get(existing.item_id), undefined);
  assert.equal(db.prepare('SELECT status FROM items WHERE id = ?').get(existing.item_id)?.status, 'indexed');
  assert.equal(vectorIndexAvailable(db), false);
});

test('canonical embedding insertion failure preserves successful FTS ingestion without disabling a healthy vector index', async t => {
  const db = openMemoryDatabase();
  t.after(() => db.close());
  db.exec(`CREATE TRIGGER reject_canonical_embedding BEFORE INSERT ON item_embeddings
    BEGIN SELECT RAISE(ABORT, 'Fixture canonical write failure'); END`);
  const source: ExtractedSource = { sourceType: 'text', sourceUri: null, canonicalUrl: null, finalUrl: null,
    title: TITLE, extractedText: 'Cache dependencies preserve freshness.', truncated: false,
    contentHash: 'sha256:canonical-insert-failure', rawBytesHash: null, provenance: {} };
  const result = await new ItemStore(db).ingest({ principal: 'local', requestId: randomUUID(), payloadHash: 'canonical-failure',
    source, analyze: async () => analysis('Canonicalfailure keeps lexical reading.') });
  assert.equal(result.status, 'indexed');
  assert.deepEqual(queryCorpus(db, { query: 'canonicalfailure' }).citations, [result.item_id]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM item_embeddings').get()?.n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM item_vec_rowids').get()?.n, 0);
  assert.equal(vectorIndexAvailable(db), true);
  assert.equal(embeddingHealth(db, MODEL).missing_items, 1);
});

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
