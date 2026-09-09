import test from 'node:test';
import assert from 'node:assert/strict';
import { runReadingMemoryEval, summarizeReadingMemoryEval, type ReadingMemoryEvalResult } from './reading-memory-eval.js';
import { readingMemoryBriefFixtures } from './reading-memory-brief-fixtures.js';
import { readingMemoryEvalFixtures, readingMemoryQueryFixtures } from './reading-memory-fixtures.js';

test('synthetic eval cases have unique IDs and valid expected corpus identities', () => {
  const corpusIds = new Set(readingMemoryEvalFixtures.map((item) => item.id));
  assert.equal(corpusIds.size, readingMemoryEvalFixtures.length);
  const caseIds = [...readingMemoryQueryFixtures, ...readingMemoryBriefFixtures].map((item) => item.id);
  assert.equal(new Set(caseIds).size, caseIds.length);
  for (const query of readingMemoryQueryFixtures) {
    for (const id of [...query.expected, ...(query.forbidden ?? [])]) assert.ok(corpusIds.has(id), id);
  }
  for (const brief of readingMemoryBriefFixtures) {
    const ids = new Set(brief.items.map((item) => item.id));
    assert.equal(ids.size, brief.items.length);
    for (const id of [...brief.expected, ...(brief.forbidden ?? []), ...(brief.due ?? []), ...(brief.repeats ?? [])]) {
      assert.ok(ids.has(id), `${brief.id}: ${id}`);
    }
    for (const event of brief.events ?? []) assert.ok(ids.has(event.item), `${brief.id}: ${event.item}`);
  }
});

test('reading memory eval passes recall, briefing and durability gates deterministically', async () => {
  const results = await runReadingMemoryEval();
  assert.equal(results.filter((result) => result.check === 'query_recall').length, 15);
  assert.equal(results.filter((result) => result.check === 'brief_selection').length, 8);
  assert.equal(results.filter((result) => result.check === 'memory_durability').length, 3);
  assert.equal(results.filter((result) => result.check === 'hybrid_retrieval').length, 3);
  assert.deepEqual(results.filter((result) => !result.passed), []);
  assert.deepEqual(await runReadingMemoryEval(), results);
  const summary = summarizeReadingMemoryEval(results);
  assert.equal(summary.mean_recall_at_5, 1);
  assert.equal(summary.checks, 29);
  assert.equal(summary.hybrid_cases, 3);
  assert.equal(summary.passed_hybrid_cases, 3);
  assert.match(summary.scope, /canned analyses and embedding vectors/);
  assert.equal(summary.unsupported_query_false_positives, 0);
  assert.equal(summary.unsupported_answers, 0);
  assert.equal(summary.irrelevant_brief_selections, 0);
  assert.equal(summary.missed_due_items, 0);
  assert.equal(summary.unwanted_repeats, 0);
});

test('eval summary reports degraded recall and selection failures instead of hiding them', () => {
  const failures: ReadingMemoryEvalResult[] = [
    { fixture_id: 'partial-recall', check: 'query_recall', passed: false,
      details: { recall_at_5: 0.5, unsupported_result_count: 0, unsupported_answer: false } },
    { fixture_id: 'no-evidence', check: 'query_recall', passed: false,
      details: { recall_at_5: null, unsupported_result_count: 2, unsupported_answer: true } },
    { fixture_id: 'bad-brief', check: 'brief_selection', passed: false,
      details: { irrelevant_selections: ['wrong'], missed_due_items: ['due'], unwanted_repeats: ['repeat'] } },
    { fixture_id: 'bad-hybrid', check: 'hybrid_retrieval', passed: false, details: { unsupported_result_count: 1 } }
  ];
  const summary = summarizeReadingMemoryEval(failures);
  assert.equal(summary.passed, false);
  assert.equal(summary.hybrid_cases, 1);
  assert.equal(summary.passed_hybrid_cases, 0);
  assert.equal(summary.mean_recall_at_5, 0.5);
  assert.equal(summary.positive_query_cases, 1);
  assert.equal(summary.unsupported_query_false_positives, 1);
  assert.equal(summary.unsupported_result_false_positives, 2);
  assert.equal(summary.unsupported_answers, 1);
  assert.equal(summary.irrelevant_brief_selections, 1);
  assert.equal(summary.missed_due_items, 1);
  assert.equal(summary.unwanted_repeats, 1);
});
