import * as v from 'valibot';
import { LIMITS } from '../config.js';
import { ProviderReadingAnalysisSchema, type ReadingAnalysis } from './analysis-schema.js';
import { READING_CONTEXT_LIMITS, type buildReadingContext, type PriorReadingItem } from './reading-context.js';

export type EvidencePassage = { passage_id: string; text: string };
export type RawProviderAnalysisInput = {
  item_id: string;
  title: string | null;
  text: string;
  /** Extraction or stored-source truncation, before this payload builder runs. */
  source_text_truncated?: boolean;
  reader_context: ReturnType<typeof buildReadingContext>['reader_context'];
  prior_items: PriorReadingItem[];
};
export type ProviderAnalysisInput = Omit<RawProviderAnalysisInput, 'text' | 'prior_items'> & {
  source_passages: EvidencePassage[];
  source_text_truncated: boolean;
  prior_items: Array<Omit<PriorReadingItem, 'source_passages'> & { source_passages: EvidencePassage[] }>;
};

/** The live analyzer and frozen-input evaluations share this exact provider payload builder.
 * IDs are scoped to this request. Source text is presented once, in verbatim slices.
 */
export function prepareProviderAnalysisInput(input: RawProviderAnalysisInput): ProviderAnalysisInput {
  const text = input.text.slice(0, LIMITS.maxExtractedChars);
  const priorItems = input.prior_items.slice(0, READING_CONTEXT_LIMITS.priorItems);
  if (priorItems.some(item => item.item_id === input.item_id)
    || new Set(priorItems.map(item => item.item_id)).size !== priorItems.length) {
    throw new Error('Analysis evidence requires distinct current and prior item IDs.');
  }
  return {
    item_id: input.item_id,
    title: input.title,
    reader_context: structuredClone(input.reader_context),
    source_passages: splitPassages(text).map((passage, index) => ({ passage_id: `current:${index + 1}`, text: passage })),
    source_text_truncated: input.source_text_truncated === true || text.length !== input.text.length,
    prior_items: priorItems.map((item, index) => ({
      ...structuredClone(item),
      source_passages: item.source_passages.slice(0, READING_CONTEXT_LIMITS.sourcePassages)
        .map((passage, passageIndex) => ({ passage_id: `prior:${index + 1}:${passageIndex + 1}`,
          text: passage.slice(0, READING_CONTEXT_LIMITS.passageChars) }))
    }))
  };
}

/** Keep original punctuation and whitespace; favor sentence/paragraph boundaries without
 * dropping delimiters. Every character of the bounded current source appears exactly once.
 */
function splitPassages(text: string): string[] {
  const passages: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + READING_CONTEXT_LIMITS.passageChars);
    if (end < text.length) {
      const window = text.slice(start, end);
      const boundaries = [...window.matchAll(/\n|[.!?][ \t]/g)];
      const last = boundaries.at(-1);
      if (last && last.index! >= READING_CONTEXT_LIMITS.passageChars / 2) end = start + last.index! + last[0].length;
      // Do not cut a Unicode surrogate pair in half.
      if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    }
    passages.push(text.slice(start, end));
    start = end;
  }
  return passages;
}

/** Parse the strict provider contract, then drop references outside the supplied source
 * and selected target. This verifies provenance, not the truth of a relationship label.
 * Final normalizeAnalysis still validates resolved quotes against the original source/context.
 */
export function resolveProviderAnalysisOutput(value: unknown, input: ProviderAnalysisInput): ReadingAnalysis {
  const result = v.parse(ProviderReadingAnalysisSchema, value);
  const current = new Map(input.source_passages.map(passage => [passage.passage_id, passage.text]));
  const targets = new Map(input.prior_items.map(item => [item.item_id,
    new Map(item.source_passages.map(passage => [passage.passage_id, passage.text]))]));
  return {
    ...result,
    relationships: result.relationships.flatMap(relationship => {
      if (relationship.from_item_id !== input.item_id || relationship.to_item_id === input.item_id || !relationship.evidence) return [];
      const source = current.get(relationship.evidence.source_passage_id);
      const target = targets.get(relationship.to_item_id)?.get(relationship.evidence.target_passage_id);
      if (!source?.trim() || !target?.trim() || source.length > 1500 || target.length > 1500) return [];
      return [{ ...relationship, evidence: { source_quote: source, target_quote: target } }];
    })
  };
}
