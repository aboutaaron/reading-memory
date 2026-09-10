import { createHash } from 'node:crypto';

/** Evaluation-only receipts. These are not new API response fields. */
export interface AnswerSourceCase {
  case_id: string;
  prompt: string;
  prompt_kind: 'explicit_sources' | 'ambiguous_recall';
  /** Freeze before retrieval, even when the wording is ambiguous. */
  intended_source_ids: string[];
  expected_outcomes: AnswerReceipt['outcome'][];
  sources: Array<{
    item_id: string;
    title: string;
    url: string;
    publisher: string;
    text: string;
    source_family?: { id: string; resolution: 'complete' | 'bounded_fallback' };
  }>;
}

export interface AnswerReceipt {
  answer: string;
  outcome: 'answer' | 'partial' | 'abstain' | 'clarify';
  /** Record actual item reads, not merely IDs present in retrieval results. */
  opened_source_ids: string[];
  compared_source_ids: string[];
  missing_source_ids: string[];
  claims: Array<{
    claim_id: string;
    text: string;
    citations: Array<{ item_id: string; quote: string }>;
  }>;
  family_assertions: Array<{
    item_ids: string[];
    assertion: 'same_family' | 'different_families' | 'independent_sources' | 'unknown';
  }>;
}

/** Collected by a separate reviewer after reading the complete answer and sources. */
export interface AnswerSourceReview {
  receipt_sha256: string;
  case_sha256: string;
  reviewer: string;
  /** Includes unsupported prose omitted from the structured claims. */
  claims_cover_answer: boolean;
  entailment: Array<{ claim_id: string; supported: boolean | null }>;
  /** Does the prose actually compare the intended sources, or disclose their absence? */
  requested_source_alignment: boolean | null;
  completeness: boolean | null;
  abstention_appropriate: boolean | null;
  /** Family diversity alone never proves independence. Review assertion indices. */
  independence: Array<{ assertion_index: number; supported: boolean | null }>;
}

export function answerReceiptHash(receipt: AnswerReceipt): string {
  return createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
}

export function answerCaseHash(testCase: AnswerSourceCase): string {
  return createHash('sha256').update(JSON.stringify(testCase)).digest('hex');
}

function unique(values: string[]): string[] { return [...new Set(values)]; }
function aggregate(values: Array<boolean | null>): boolean | null {
  if (values.includes(false)) return false;
  return values.length === 0 || values.includes(null) ? null : true;
}

export function evaluateAnswerSources(
  testCase: AnswerSourceCase,
  receipt: AnswerReceipt,
  review?: AnswerSourceReview,
) {
  const sources = new Map(testCase.sources.map(source => [source.item_id, source]));
  if (sources.size !== testCase.sources.length ||
      unique(receipt.claims.map(claim => claim.claim_id)).length !== receipt.claims.length) {
    throw new Error('Evaluation identities must be unique');
  }
  if (review && (review.receipt_sha256 !== answerReceiptHash(receipt) ||
      review.case_sha256 !== answerCaseHash(testCase) || !review.reviewer.trim())) {
    throw new Error('Review must identify a reviewer and match the exact case and receipt');
  }
  const claimIds = new Set(receipt.claims.map(claim => claim.claim_id));
  if (review && (unique(review.entailment.map(label => label.claim_id)).length !== review.entailment.length ||
      review.entailment.some(label => !claimIds.has(label.claim_id)) ||
      new Set(review.independence.map(label => label.assertion_index)).size !== review.independence.length ||
      review.independence.some(label => !Number.isInteger(label.assertion_index) ||
        receipt.family_assertions[label.assertion_index]?.assertion !== 'independent_sources'))) {
    throw new Error('Review labels must reference unique existing claims or independence assertions');
  }

  const opened = new Set(receipt.opened_source_ids);
  const cited = new Set<string>();
  let quoteTotal = 0;
  let quotePresent = 0;
  const quoteChecks: boolean[] = [];
  for (const claim of receipt.claims) {
    for (const citation of claim.citations) {
      quoteTotal++;
      const present = citation.quote.trim().length > 0 &&
        (sources.get(citation.item_id)?.text.includes(citation.quote) ?? false);
      if (present) quotePresent++;
      const usable = present && opened.has(citation.item_id);
      quoteChecks.push(present);
      if (usable) cited.add(citation.item_id);
    }
  }
  const missingIntended = unique(testCase.intended_source_ids).filter(id => !cited.has(id));
  const assertedComparison = new Set(receipt.compared_source_ids);
  const intended = new Set(testCase.intended_source_ids);
  // This establishes identities represented by receipts, not whether prose entails a comparison.
  const aligned = missingIntended.length === 0 &&
    [...intended].every(id => assertedComparison.has(id)) &&
    [...assertedComparison].every(id => intended.has(id) && cited.has(id));
  const trulyUnavailable = [...intended].filter(id => !sources.has(id));
  const honestMissing = receipt.missing_source_ids.length > 0 &&
    unique(receipt.missing_source_ids).length === receipt.missing_source_ids.length &&
    receipt.missing_source_ids.every(id => intended.has(id) && trulyUnavailable.includes(id)) &&
    trulyUnavailable.every(id => receipt.missing_source_ids.includes(id));
  const identityCheck = receipt.outcome === 'answer' ? aligned :
    (receipt.outcome === 'partial' || receipt.outcome === 'abstain') ? honestMissing : null;

  const familyChecks = receipt.family_assertions.map((assertion, index): boolean | null => {
    const ids = unique(assertion.item_ids);
    if (ids.length < 2 || ids.length !== assertion.item_ids.length || ids.some(id => !sources.has(id))) return false;
    const families = ids.map(id => sources.get(id)!.source_family);
    const known = families.every(family => family?.resolution === 'complete');
    if (assertion.assertion === 'unknown') return known ? null : true;
    if (!known) return false; // Unavailable metadata cannot support an affirmative identity claim.
    const familyIds = new Set(families.map(family => family!.id));
    if (assertion.assertion === 'same_family') return familyIds.size === 1;
    if (assertion.assertion === 'different_families') return familyIds.size === ids.length;
    if (familyIds.size !== ids.length) return false;
    return review?.independence.find(label => label.assertion_index === index)?.supported ?? null;
  });
  const entailment = receipt.claims.map(claim =>
    review?.entailment.find(label => label.claim_id === claim.claim_id)?.supported ?? null);
  const entailmentResult = review?.claims_cover_answer === false ? false :
    review ? aggregate(entailment) : null;

  return {
    case_id: testCase.case_id,
    prompt_kind: testCase.prompt_kind,
    quote_presence: { present: quotePresent, total: quoteTotal, all_present: aggregate(quoteChecks) },
    source_opening: { all_citations_opened: aggregate(receipt.claims.flatMap(claim => claim.citations)
      .map(citation => sources.has(citation.item_id) && opened.has(citation.item_id))) },
    requested_source_alignment: {
      // Do not score an ambiguous question against a hidden intention as if it named the sources.
      passed: testCase.prompt_kind === 'ambiguous_recall' ? null :
        aggregate([identityCheck, review?.requested_source_alignment ?? null]),
      receipt_identity_check: identityCheck,
      intended_sources_cited: [...intended].filter(id => cited.has(id)).length,
      intended_sources_total: intended.size,
      missing_intended_source_ids: missingIntended,
    },
    family_assertions: { passed: aggregate(familyChecks), checks: familyChecks },
    semantic_entailment: { passed: entailmentResult, reviewed: !!review, claim_checks: entailment },
    completeness: { passed: review?.completeness ?? null },
    abstention: {
      outcome_matches_frozen_expectation: testCase.expected_outcomes.includes(receipt.outcome),
      appropriate: review?.abstention_appropriate ?? null,
    },
    receipt_sha256: answerReceiptHash(receipt),
  };
}
