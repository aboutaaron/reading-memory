import test from 'node:test';
import assert from 'node:assert/strict';
import { answerCaseHash, answerReceiptHash, evaluateAnswerSources } from './answer-source-evaluation.js';
import { correctComparison, explicitComparison, syntheticAnswerSourceFixtures } from './answer-source-fixtures.js';
import { runAnswerSourceEval } from './answer-source-eval.js';

test('synthetic answer controls distinguish genuine quotations, meaning, requested identities and families', () => {
  const checks = runAnswerSourceEval();
  assert.equal(checks.length, 12);
  assert.deepEqual(checks.filter(check => !check.passed), []);
  const wrong = checks.find(check => check.id === 'genuine-quotes-wrong-source')!;
  assert.equal(wrong.dimensions.quotes, true);
  assert.equal(wrong.dimensions.entailment, true);
  assert.equal(wrong.dimensions.alignment, false);
  const falseMeaning = checks.find(check => check.id === 'genuine-quotes-unsupported-meaning')!;
  assert.equal(falseMeaning.dimensions.quotes, true);
  assert.equal(falseMeaning.dimensions.entailment, false);
});

test('without manual labels exact quotes do not imply entailment, comparison correctness or completeness', () => {
  const result = evaluateAnswerSources(explicitComparison, correctComparison);
  assert.equal(result.quote_presence.all_present, true);
  assert.equal(result.requested_source_alignment.receipt_identity_check, true);
  assert.equal(result.requested_source_alignment.passed, null);
  assert.equal(result.semantic_entailment.passed, null);
  assert.equal(result.completeness.passed, null);
  assert.equal(result.abstention.appropriate, null);
});

test('a review cannot be reused after answer, claim or frozen source changes', () => {
  const fixture = structuredClone(syntheticAnswerSourceFixtures()[0]!);
  const edited = structuredClone(fixture.receipt);
  edited.answer += ' An unsupported addition.';
  assert.throws(() => evaluateAnswerSources(fixture.test_case, edited, fixture.review), /exact case and receipt/);
  const changedSource = structuredClone(fixture.test_case);
  changedSource.sources[0]!.text = 'Different source text.';
  assert.throws(() => evaluateAnswerSources(changedSource, fixture.receipt, fixture.review), /exact case and receipt/);
  const changedPrompt = structuredClone(fixture.test_case);
  changedPrompt.prompt = 'A different task';
  assert.throws(() => evaluateAnswerSources(changedPrompt, fixture.receipt, fixture.review), /exact case and receipt/);
});

test('name-dropping intended IDs with authentic quotes cannot override manual wrong-comparison finding', () => {
  const fixture = structuredClone(syntheticAnswerSourceFixtures()[0]!);
  fixture.receipt.answer = 'C recommends a searchable notebook.';
  fixture.review.receipt_sha256 = answerReceiptHash(fixture.receipt);
  fixture.review.requested_source_alignment = false;
  fixture.review.claims_cover_answer = false;
  const result = evaluateAnswerSources(fixture.test_case, fixture.receipt, fixture.review);
  assert.equal(result.quote_presence.all_present, true);
  assert.equal(result.requested_source_alignment.receipt_identity_check, true);
  assert.equal(result.requested_source_alignment.passed, false);
  assert.equal(result.semantic_entailment.passed, false);
});

test('source-opening and exact text provenance are independent checks', () => {
  const receipt = structuredClone(correctComparison);
  receipt.opened_source_ids = ['essay-a'];
  let result = evaluateAnswerSources(explicitComparison, receipt);
  assert.equal(result.quote_presence.all_present, true);
  assert.equal(result.source_opening.all_citations_opened, false);
  assert.equal(result.requested_source_alignment.passed, false);
  receipt.claims[0]!.citations[0]!.item_id = 'essay-c';
  result = evaluateAnswerSources(explicitComparison, receipt);
  assert.equal(result.quote_presence.all_present, false);
  receipt.claims[0]!.citations[0]!.quote = ' ';
  assert.equal(evaluateAnswerSources(explicitComparison, receipt).quote_presence.all_present, false);
});

test('truthful missing-source disclosure is tied to frozen supplied sources', () => {
  const fixture = structuredClone(syntheticAnswerSourceFixtures().find(f => f.id === 'missing-requested-source-abstention')!);
  assert.equal(evaluateAnswerSources(fixture.test_case, fixture.receipt, fixture.review).requested_source_alignment.passed, true);
  fixture.test_case.sources.push(structuredClone(explicitComparison.sources[1]!));
  fixture.review.case_sha256 = answerCaseHash(fixture.test_case);
  assert.equal(evaluateAnswerSources(fixture.test_case, fixture.receipt, fixture.review).requested_source_alignment.passed, false);
});

test('partial answers require opened quoted available sources despite optimistic manual alignment', () => {
  const fixture = structuredClone(syntheticAnswerSourceFixtures().find(f => f.id === 'missing-requested-source-abstention')!);
  fixture.receipt.outcome = 'partial';
  fixture.receipt.answer = 'A critiques the metaphor; B is unavailable, so I cannot finish the comparison.';
  fixture.receipt.compared_source_ids = ['essay-a'];
  fixture.receipt.claims = [structuredClone(correctComparison.claims[0]!)];
  fixture.review.entailment = [{ claim_id: 'critique', supported: true }];
  fixture.review.requested_source_alignment = true;
  const score = () => {
    fixture.review.receipt_sha256 = answerReceiptHash(fixture.receipt);
    return evaluateAnswerSources(fixture.test_case, fixture.receipt, fixture.review).requested_source_alignment;
  };
  assert.equal(score().passed, true, 'A is opened and quoted; missing B is honestly disclosed');
  fixture.receipt.opened_source_ids = [];
  assert.equal(score().passed, false, 'A was never opened');
  fixture.receipt.opened_source_ids = ['essay-a'];
  fixture.receipt.claims[0]!.citations = [];
  assert.equal(score().passed, false, 'A is opened but has no citation');
  const sourceC = explicitComparison.sources[2]!;
  fixture.receipt.opened_source_ids = ['essay-c'];
  fixture.receipt.compared_source_ids = ['essay-c'];
  fixture.receipt.claims[0]!.citations = [{ item_id: sourceC.item_id, quote: sourceC.text }];
  assert.equal(score().passed, false, 'C has a genuine quotation but substitutes for A');
  fixture.receipt.opened_source_ids = ['essay-a', 'essay-c'];
  fixture.receipt.claims[0]!.citations.push(...structuredClone(correctComparison.claims[0]!.citations));
  assert.equal(score().passed, false, 'adding an A quotation does not make a C comparison valid');
});

test('abstention needs no positive citation but cannot hide a substituted comparison', () => {
  const fixture = structuredClone(syntheticAnswerSourceFixtures().find(f => f.id === 'missing-requested-source-abstention')!);
  fixture.receipt.opened_source_ids = [];
  fixture.review.receipt_sha256 = answerReceiptHash(fixture.receipt);
  assert.equal(evaluateAnswerSources(fixture.test_case, fixture.receipt, fixture.review).requested_source_alignment.passed, true);
  fixture.receipt.compared_source_ids = ['essay-c'];
  fixture.review.receipt_sha256 = answerReceiptHash(fixture.receipt);
  assert.equal(evaluateAnswerSources(fixture.test_case, fixture.receipt, fixture.review).requested_source_alignment.passed, false);
  fixture.receipt.compared_source_ids = [];
  const sourceC = explicitComparison.sources[2]!;
  fixture.receipt.claims = [{ claim_id: 'substitute', text: sourceC.text,
    citations: [{ item_id: sourceC.item_id, quote: sourceC.text }] }];
  fixture.review.entailment = [{ claim_id: 'substitute', supported: true }];
  fixture.review.receipt_sha256 = answerReceiptHash(fixture.receipt);
  assert.equal(evaluateAnswerSources(fixture.test_case, fixture.receipt, fixture.review).requested_source_alignment.passed, false);
});

test('ambiguous recall keeps intended identities frozen without treating them as explicit instructions', () => {
  const fixture = syntheticAnswerSourceFixtures().find(f => f.id === 'ambiguous-question-silently-substituted')!;
  const result = evaluateAnswerSources(fixture.test_case, fixture.receipt, fixture.review);
  assert.deepEqual(fixture.test_case.intended_source_ids, ['essay-a', 'essay-b']);
  assert.equal(result.requested_source_alignment.passed, null);
  assert.equal(result.abstention.outcome_matches_frozen_expectation, false);
});

test('family assertions cannot invent identities from publisher, URLs or unknown metadata', () => {
  const fixture = structuredClone(syntheticAnswerSourceFixtures().find(f => f.id === 'same-publisher-different-urls')!);
  assert.equal(evaluateAnswerSources(fixture.test_case, fixture.receipt).family_assertions.passed, false);
  fixture.receipt.family_assertions[0]!.assertion = 'different_families';
  assert.equal(evaluateAnswerSources(fixture.test_case, fixture.receipt).family_assertions.passed, true);
  delete fixture.test_case.sources[0]!.source_family;
  assert.equal(evaluateAnswerSources(fixture.test_case, fixture.receipt).family_assertions.passed, false);
  fixture.receipt.family_assertions[0]!.assertion = 'unknown';
  assert.equal(evaluateAnswerSources(fixture.test_case, fixture.receipt).family_assertions.passed, true);
});

test('bounded family fallbacks and duplicate receipt IDs never prove independence', () => {
  const fixture = structuredClone(syntheticAnswerSourceFixtures().find(f => f.id === 'distinct-families-independence-unreviewed')!);
  fixture.test_case.sources[0]!.source_family!.resolution = 'bounded_fallback';
  assert.equal(evaluateAnswerSources(fixture.test_case, fixture.receipt).family_assertions.passed, false);
  fixture.receipt.family_assertions[0]!.item_ids = ['essay-a', 'essay-a'];
  assert.equal(evaluateAnswerSources(fixture.test_case, fixture.receipt).family_assertions.passed, false);
});

test('distinct families require additional explicit review before an independence assertion passes', () => {
  const fixture = structuredClone(syntheticAnswerSourceFixtures().find(f => f.id === 'distinct-families-independence-unreviewed')!);
  assert.equal(evaluateAnswerSources(fixture.test_case, fixture.receipt, fixture.review).family_assertions.passed, null);
  fixture.review.independence = [{ assertion_index: 0, supported: false }];
  assert.equal(evaluateAnswerSources(fixture.test_case, fixture.receipt, fixture.review).family_assertions.passed, false);
  fixture.review.independence[0]!.supported = true;
  assert.equal(evaluateAnswerSources(fixture.test_case, fixture.receipt, fixture.review).family_assertions.passed, true);
});

test('incomplete review remains unknown and duplicate or unknown labels fail validation', () => {
  const fixture = structuredClone(syntheticAnswerSourceFixtures()[0]!);
  fixture.review.entailment.pop();
  assert.equal(evaluateAnswerSources(fixture.test_case, fixture.receipt, fixture.review).semantic_entailment.passed, null);
  fixture.review.entailment.push({ claim_id: 'invented', supported: true });
  assert.throws(() => evaluateAnswerSources(fixture.test_case, fixture.receipt, fixture.review), /unique existing/);
  fixture.review.entailment = [{ claim_id: 'critique', supported: true }, { claim_id: 'critique', supported: false }];
  assert.throws(() => evaluateAnswerSources(fixture.test_case, fixture.receipt, fixture.review), /unique existing/);
});
