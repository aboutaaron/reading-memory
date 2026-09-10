import { pathToFileURL } from 'node:url';
import { evaluateAnswerSources } from './answer-source-evaluation.js';
import { syntheticAnswerSourceFixtures, type SyntheticExpectations } from './answer-source-fixtures.js';

export function runAnswerSourceEval() {
  return syntheticAnswerSourceFixtures().map(fixture => {
    const result = evaluateAnswerSources(fixture.test_case, fixture.receipt, fixture.review);
    const actual: SyntheticExpectations = {
      quotes: result.quote_presence.all_present,
      alignment: result.requested_source_alignment.passed,
      families: result.family_assertions.passed,
      entailment: result.semantic_entailment.passed,
      completeness: result.completeness.passed,
      outcome: result.abstention.outcome_matches_frozen_expectation,
    };
    return {
      id: fixture.id,
      passed: Object.keys(fixture.expected).every(key => actual[key as keyof SyntheticExpectations] === fixture.expected[key as keyof SyntheticExpectations]),
      dimensions: actual,
    };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const checks = runAnswerSourceEval();
  console.log(JSON.stringify({
    scope: 'Synthetic receipt-scoring regression controls with authored labels; no generated answers or live model quality measurement.',
    checks: checks.length, passed: checks.filter(check => check.passed).length, results: checks,
  }, null, 2));
  if (checks.some(check => !check.passed)) process.exitCode = 1;
}
