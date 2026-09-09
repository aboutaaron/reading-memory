import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { backfillTitles } from '../../scripts/backfill-titles.js';
import { openMemoryDatabase } from '../db/connection.js';
import { ItemStore } from './item-store.js';
import { embeddingHash, embeddingText, vectorNeighbors } from './embeddings.js';
import { getItem, queryCorpus } from './corpus-query.js';
import type { Analysis, ExtractedSource } from './types.js';

const MODEL = 'test/title-race';
const vector = [1, ...Array<number>(1535).fill(0)];
const judgment: Analysis = {
  summary: 'Cache invalidation requires explicit dependencies.', claims: ['Cache dependencies matter.'],
  relevance: { score: 0.9, themes: ['caching'] }, recommended_action: 'save', confidence: 0.8,
  reason: 'Tracks refresh dependencies.', tags: [], relationships: [], model: 'test', analysis_version: 'test'
};

for (const operation of ['ingest', 'reanalyze'] as const) {
  test(`${operation} discards stale embeddings when title maintenance completes during analysis`, async t => {
    const db = openMemoryDatabase();
    t.after(() => db.close());
    const store = new ItemStore(db);
    const source: ExtractedSource = {
      sourceType: 'text', sourceUri: null, canonicalUrl: null, finalUrl: null,
      title: null, extractedText: '# Fresh Cache Policy\n\nCache dependencies matter.', truncated: false,
      contentHash: `sha256:title-race-${operation}`, rawBytesHash: null, provenance: {}
    };
    const analyze = async (_itemId: string, captured: ExtractedSource): Promise<Analysis> => ({
      ...judgment,
      embedding: { model: MODEL, vector, inputHash: embeddingHash(embeddingText(captured.title, judgment)) }
    });
    const ingestInput = { principal: 'local', requestId: randomUUID(), payloadHash: source.contentHash, source, analyze };
    const existing = operation === 'reanalyze' ? await store.ingest(ingestInput) : null;
    let itemId = existing?.item_id ?? '';
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const heldAnalyze = async (capturedItemId: string, captured: ExtractedSource) => {
      itemId = capturedItemId;
      const result = await analyze(capturedItemId, captured);
      assert.equal(captured.title, null);
      started();
      await new Promise<void>(resolve => { release = resolve; });
      return result;
    };
    const pending = operation === 'reanalyze'
      ? store.reanalyze({ principal: 'local', requestId: randomUUID(), itemId, analyze: heldAnalyze })
      : store.ingest({ ...ingestInput, analyze: heldAnalyze });
    await entered;

    assert.equal(backfillTitles(db, true).applied, 1);
    release();
    const result = await pending;

    assert.equal(result.status, 'indexed');
    assert.equal(result.title, 'Fresh Cache Policy');
    assert.equal(result.summary, judgment.summary);
    assert.equal(db.prepare('SELECT 1 FROM item_embeddings WHERE item_id = ?').get(itemId), undefined);
    assert.equal(db.prepare('SELECT 1 FROM item_vec WHERE item_id = ?').get(itemId), undefined);
    assert.deepEqual(vectorNeighbors(db, vector, MODEL), []);
    assert.deepEqual(queryCorpus(db, { query: 'fresh cache policy' }).citations, [itemId]);
    assert.equal(getItem(db, itemId)?.embedding_status, 'missing');
  });
}
