import * as v from 'valibot';
import { toJsonSchema } from '@valibot/to-json-schema';

export const ReadingAnalysisSchema = v.strictObject({
  summary: v.string(),
  claims: v.array(v.string()),
  relevance: v.strictObject({
    score: v.number(),
    themes: v.array(v.string())
  }),
  recommended_action: v.picklist(['brief', 'save', 'skip']),
  confidence: v.number(),
  reason: v.string(),
  tags: v.array(v.strictObject({
    tag: v.string(),
    reason: v.string(),
    confidence: v.number()
  })),
  relationships: v.array(v.strictObject({
    from_item_id: v.string(),
    to_item_id: v.string(),
    relation_type: v.string(),
    explanation: v.string(),
    confidence: v.number(),
    evidence: v.nullish(v.strictObject({
      source_quote: v.string(),
      target_quote: v.string()
    }))
  }))
});

export type ReadingAnalysis = v.InferOutput<typeof ReadingAnalysisSchema>;


// Strict provider output requires every key; null evidence means no supported relationship.
const relationshipEntries = ReadingAnalysisSchema.entries.relationships.item.entries;
export const readingAnalysisJsonSchema = toJsonSchema(v.strictObject({
  ...ReadingAnalysisSchema.entries,
  relationships: v.array(v.strictObject({ ...relationshipEntries, evidence: v.nullable(relationshipEntries.evidence.wrapped) }))
})) as { type: 'object'; [key: string]: unknown };
