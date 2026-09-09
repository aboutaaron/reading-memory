import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase } from '../db/connection.js';
import { createEmbeddingReadingAnalyzer } from './server.js';
import type { ReadingAnalyzerInput } from '../reading/flue-agent.js';
import type { Analysis } from '../reading/types.js';

const analysis: Analysis = {
  summary: 'Cache invalidation requires explicit dependencies.', claims: ['Cache dependencies matter.'],
  relevance: { score: 0.9, themes: ['caching'] }, recommended_action: 'save', confidence: 0.8,
  reason: 'Tracks refresh dependencies.', tags: [], relationships: [], model: 'test', analysis_version: 'test'
};
const input = { itemId: 'item_deadline', title: 'Cache policy', text: 'Cache invalidation depends on ownership.' };
const vector = [1, ...Array<number>(1535).fill(0)];

test('a hung post-analysis embedding preserves successful analysis before the request deadline', { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const db = openMemoryDatabase();
  t.after(() => db.close());
  const controller = new AbortController();
  let calls = 0;
  let embeddingSignal: AbortSignal | undefined;
  const analyze = createEmbeddingReadingAnalyzer(db, async received => {
    assert.equal(received.signal, controller.signal);
    // Model work has used nearly all the budget. Only 25ms remain for optional indexing.
    t.mock.timers.setTime(1725);
    return analysis;
  }, {
    model: 'test/embedding',
    async embed(_text, signal) {
      if (++calls === 1) return vector;
      embeddingSignal = signal;
      return new Promise<number[]>(() => {}); // Provider deliberately ignores AbortSignal.
    }
  });

  const result = await analyze({ ...input, signal: controller.signal, deadline: 2000 });
  assert.deepEqual(result, { ...analysis, embedding: null });
  assert.equal(calls, 2);
  assert.equal(embeddingSignal?.aborted, true);
  assert.equal(controller.signal.aborted, false);
});

test('embedding context and indexing are skipped when only the save margin remains', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const db = openMemoryDatabase();
  t.after(() => db.close());
  let calls = 0;
  let observed: ReadingAnalyzerInput | undefined;
  const controller = new AbortController();
  const analyze = createEmbeddingReadingAnalyzer(db, async received => {
    observed = received;
    return analysis;
  }, { model: 'test/embedding', async embed() { calls++; return vector; } });

  const result = await analyze({ ...input, signal: controller.signal, deadline: 1250 });
  assert.deepEqual(result, { ...analysis, embedding: null });
  assert.equal(calls, 0);
  assert.deepEqual(observed?.priorItemIds, []);
  assert.equal(observed?.signal, controller.signal);
  assert.equal(observed?.deadline, 1250);
});

test('a hung prior-source embedding times out without cancelling model analysis', { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const db = openMemoryDatabase();
  t.after(() => db.close());
  const controller = new AbortController();
  let embeddingSignal: AbortSignal | undefined;
  const analyze = createEmbeddingReadingAnalyzer(db, async received => {
    assert.deepEqual(received.priorItemIds, []);
    assert.equal(received.signal, controller.signal);
    assert.equal(received.signal?.aborted, false);
    assert.equal(embeddingSignal?.aborted, true);
    t.mock.timers.setTime(1025);
    return analysis;
  }, {
    model: 'test/embedding',
    async embed(_text, signal) {
      embeddingSignal = signal;
      return new Promise<number[]>(() => {});
    }
  });

  assert.deepEqual(await analyze({ ...input, signal: controller.signal, deadline: 1275 }),
    { ...analysis, embedding: null });
});
