import test from 'node:test';
import assert from 'node:assert/strict';
import { runReadingMemoryEval } from './reading-memory-eval.js';
import { readingMemoryEvalFixtures } from './reading-memory-fixtures.js';

test('reading memory eval fixtures have unique ids', () => {
  assert.equal(new Set(readingMemoryEvalFixtures.map((fixture) => fixture.id)).size, readingMemoryEvalFixtures.length);
});

test('reading memory eval passes core query and brief checks', async () => {
  const results = await runReadingMemoryEval();
  assert.ok(results.length >= 3);
  assert.deepEqual(results.filter((result) => !result.passed), []);
});
