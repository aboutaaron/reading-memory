import {
  answerCaseHash, answerReceiptHash,
  type AnswerReceipt, type AnswerSourceCase, type AnswerSourceReview,
} from './answer-source-evaluation.js';

// Entirely invented sources. No private corpus, captured article, or provider output.
const critique = 'The library metaphor hides how memory is reconstructed rather than retrieved unchanged.';
const qualified = 'The library metaphor remains useful for finding notes, provided we do not treat recall as an unchanged copy.';
const related = 'A searchable notebook makes it easier to find yesterday’s meeting notes.';

export const explicitComparison: AnswerSourceCase = {
  case_id: 'synthetic-named-essays',
  prompt: 'Compare Essay A, Against the Library Metaphor, with Essay B, A Qualified Library Metaphor.',
  prompt_kind: 'explicit_sources',
  intended_source_ids: ['essay-a', 'essay-b'],
  expected_outcomes: ['answer'],
  sources: [
    { item_id: 'essay-a', title: 'Against the Library Metaphor', url: 'https://example.test/essay-a',
      publisher: 'Synthetic Review', text: critique, source_family: { id: 'family-a', resolution: 'complete' } },
    { item_id: 'essay-b', title: 'A Qualified Library Metaphor', url: 'https://example.test/essay-b',
      publisher: 'Synthetic Review', text: qualified, source_family: { id: 'family-b', resolution: 'complete' } },
    { item_id: 'essay-c', title: 'Searchable Meeting Notes', url: 'https://example.test/essay-c',
      publisher: 'Synthetic Review', text: related, source_family: { id: 'family-c', resolution: 'complete' } },
  ],
};

export const correctComparison: AnswerReceipt = {
  answer: 'A criticizes the metaphor for hiding reconstruction; B retains it for finding notes with the same limitation.',
  outcome: 'answer', opened_source_ids: ['essay-a', 'essay-b'], compared_source_ids: ['essay-a', 'essay-b'],
  missing_source_ids: [], family_assertions: [],
  claims: [
    { claim_id: 'critique', text: 'A says the metaphor hides reconstruction.', citations: [{ item_id: 'essay-a', quote: critique }] },
    { claim_id: 'qualification', text: 'B keeps the metaphor for finding notes, with a caveat about recall.',
      citations: [{ item_id: 'essay-b', quote: qualified }] },
  ],
};

export type SyntheticExpectations = {
  quotes: boolean | null;
  alignment: boolean | null;
  families: boolean | null;
  entailment: boolean | null;
  completeness: boolean | null;
  outcome: boolean;
};
export interface SyntheticAnswerFixture {
  id: string;
  test_case: AnswerSourceCase;
  receipt: AnswerReceipt;
  /** Authored control labels, not results of a human study or automated semantic judge. */
  review: AnswerSourceReview;
  expected: SyntheticExpectations;
}

function fixture(
  id: string, testCase: AnswerSourceCase, receipt: AnswerReceipt,
  expected: SyntheticExpectations,
): SyntheticAnswerFixture {
  return {
    id, test_case: testCase, receipt, expected,
    review: {
      reviewer: 'synthetic-control-author', receipt_sha256: answerReceiptHash(receipt), case_sha256: answerCaseHash(testCase),
      claims_cover_answer: true,
      entailment: receipt.claims.map(claim => ({ claim_id: claim.claim_id, supported: expected.entailment })),
      requested_source_alignment: expected.alignment,
      completeness: expected.completeness,
      abstention_appropriate: receipt.outcome === 'abstain' || receipt.outcome === 'clarify' ? expected.outcome : null,
      independence: [],
    },
  };
}

export function syntheticAnswerSourceFixtures(): SyntheticAnswerFixture[] {
  const base = { quotes: true, alignment: true, families: null, entailment: true, completeness: true, outcome: true };
  const wrong = structuredClone(correctComparison);
  wrong.answer = 'C recommends searchable notes; B retains the library metaphor with caveats.';
  wrong.opened_source_ids = ['essay-c', 'essay-b'];
  wrong.compared_source_ids = ['essay-c', 'essay-b'];
  wrong.claims[0] = { claim_id: 'substitute', text: 'C recommends searchable notes.', citations: [{ item_id: 'essay-c', quote: related }] };

  const overstatement = structuredClone(correctComparison);
  overstatement.answer = 'Both authors reject the library metaphor entirely.';
  overstatement.claims = [{ claim_id: 'overstatement', text: overstatement.answer,
    citations: correctComparison.claims.flatMap(claim => claim.citations) }];

  const missingCase = structuredClone(explicitComparison);
  missingCase.case_id = 'synthetic-requested-source-unavailable';
  missingCase.sources = missingCase.sources.filter(source => source.item_id !== 'essay-b');
  missingCase.expected_outcomes = ['partial', 'abstain'];
  const missingReceipt: AnswerReceipt = {
    answer: 'I found A but cannot compare it with B because B is unavailable.', outcome: 'abstain',
    opened_source_ids: ['essay-a'], compared_source_ids: [], missing_source_ids: ['essay-b'], claims: [], family_assertions: [],
  };

  const ambiguousCase = structuredClone(explicitComparison);
  ambiguousCase.case_id = 'synthetic-ambiguous-recall';
  ambiguousCase.prompt_kind = 'ambiguous_recall';
  ambiguousCase.prompt = 'How did those essays about the memory metaphor disagree?';
  ambiguousCase.expected_outcomes = ['clarify'];
  const clarification: AnswerReceipt = {
    answer: 'Do you mean Against the Library Metaphor and A Qualified Library Metaphor?', outcome: 'clarify',
    opened_source_ids: [], compared_source_ids: [], missing_source_ids: [], claims: [], family_assertions: [],
  };

  const inventedFamily = structuredClone(correctComparison);
  inventedFamily.answer += ' They are captures from the same source family.';
  inventedFamily.family_assertions = [{ item_ids: ['essay-a', 'essay-b'], assertion: 'same_family' }];
  const unknownCase = structuredClone(explicitComparison);
  unknownCase.case_id = 'synthetic-missing-family-metadata';
  unknownCase.sources.forEach(source => { delete source.source_family; });
  const unknownReceipt = structuredClone(correctComparison);
  unknownReceipt.answer += ' Their family identity is unknown from the available metadata.';
  unknownReceipt.family_assertions = [{ item_ids: ['essay-a', 'essay-b'], assertion: 'unknown' }];
  const inventedIndependence = structuredClone(correctComparison);
  inventedIndependence.answer += ' They independently corroborate the claim.';
  inventedIndependence.family_assertions = [{ item_ids: ['essay-a', 'essay-b'], assertion: 'independent_sources' }];

  const repeatedCase = structuredClone(explicitComparison);
  repeatedCase.case_id = 'synthetic-repeated-captures';
  repeatedCase.sources.push(...['essay-a-copy-2', 'essay-a-copy-3'].map(item_id => ({ ...repeatedCase.sources[0]!, item_id })));
  const repeated = structuredClone(correctComparison);
  repeated.answer += ' Three captures of A represent one source family.';
  repeated.family_assertions = [{ item_ids: ['essay-a', 'essay-a-copy-2', 'essay-a-copy-3'], assertion: 'same_family' }];
  const repeatedBad = structuredClone(repeated);
  repeatedBad.answer = correctComparison.answer + ' Three independent sources corroborate A.';
  repeatedBad.family_assertions[0]!.assertion = 'independent_sources';

  return [
    fixture('named-source-comparison', explicitComparison, correctComparison, base),
    fixture('genuine-quotes-wrong-source', explicitComparison, wrong, { ...base, alignment: false, completeness: false }),
    fixture('genuine-quotes-unsupported-meaning', explicitComparison, overstatement, { ...base, entailment: false, completeness: false }),
    fixture('missing-requested-source-abstention', missingCase, missingReceipt,
      { quotes: null, alignment: true, families: null, entailment: null, completeness: false, outcome: true }),
    fixture('ambiguous-question-clarified', ambiguousCase, clarification,
      { quotes: null, alignment: null, families: null, entailment: null, completeness: false, outcome: true }),
    fixture('ambiguous-question-silently-substituted', ambiguousCase, wrong,
      { ...base, alignment: null, completeness: false, outcome: false }),
    fixture('same-publisher-different-urls', explicitComparison, inventedFamily, { ...base, families: false }),
    fixture('metadata-absent-identity-invented', unknownCase, inventedFamily, { ...base, families: false }),
    fixture('metadata-absent-uncertainty', unknownCase, unknownReceipt, { ...base, families: true }),
    fixture('distinct-families-independence-unreviewed', explicitComparison, inventedIndependence, { ...base, families: null }),
    fixture('recognized-repeated-captures', repeatedCase, repeated, { ...base, families: true }),
    fixture('repeated-captures-false-corroboration', repeatedCase, repeatedBad, { ...base, families: false }),
  ];
}
