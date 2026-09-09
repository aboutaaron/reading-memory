import * as v from 'valibot';
import type { Database } from '../db/connection.js';
import { ApiError } from '../api/errors.js';
import type { Analysis, Relationship } from './types.js';
import { canonicalRelationship, findRelationships } from './analyzer.js';
import { FlueTraceLogger } from './flue-trace.js';
import { buildReadingContext, type CallerReadingContext, type PriorReadingItem } from './reading-context.js';
import { ReadingAnalysisSchema, type ReadingAnalysis } from './analysis-schema.js';
import { requestReadingAnalysis } from './provider-analysis.js';
import { DEFAULT_READING_MODEL, resolveProviderModel } from './provider-model.js';

export const READING_ANALYSIS_VERSION = 'reading-api-sdk-v3';
export const MODEL_RELATION_TYPES = ['supports', 'contradicts', 'extends', 'duplicates_angle', 'related', 'updates'] as const;

export type ReadingAnalyzerInput = {
  itemId: string;
  priorItemIds?: string[];
  title: string | null;
  text: string;
  readerContext?: CallerReadingContext;
  sessionId?: string;
  /** Absolute request deadline in milliseconds; optional work leaves time to save analysis. */
  deadline?: number;
  /** Cancels the provider request when the caller's deadline expires. */
  signal?: AbortSignal;
};
export type ReadingAnalyzer = (input: ReadingAnalyzerInput) => Promise<Analysis>;
export type AnalyzerHealth = { status: 'ok' | 'unavailable'; warn: boolean };

/** Checks local configuration only. Provider availability is checked by the actual request. */
export function flueAnalyzerHealth(model = DEFAULT_READING_MODEL, env: NodeJS.ProcessEnv = process.env): AnalyzerHealth {
  try {
    resolveProviderModel(model, env);
    return { status: 'ok', warn: false };
  } catch {
    return { status: 'unavailable', warn: true };
  }
}

// Kept as an import-compatible name for existing service consumers; no Flue runtime remains.
export function createFlueReadingAnalyzer(db: Database, options: {
  model: string;
  tracePath?: string | null;
  env?: NodeJS.ProcessEnv;
  /** SDK transport injection for deterministic tests; never substitutes for validation. */
  fetch?: typeof fetch;
}): ReadingAnalyzer {
  const traces = new FlueTraceLogger(options.tracePath);
  return async ({ itemId, title, text, readerContext, priorItemIds, sessionId, signal }) => {
    const trace = traces.createTrace({ itemId, sessionId: sessionId ?? `analysis:${itemId}`, title, text, model: options.model });
    try {
      signal?.throwIfAborted();
      const model = resolveProviderModel(options.model, options.env);
      const readingContext = buildReadingContext(db, { itemId, title, text, ...(priorItemIds ? { priorItemIds } : {}), ...(readerContext ? { readerContext } : {}) });
      const result = await requestReadingAnalysis(model, { item_id: itemId, title, text, ...readingContext }, {
        ...(signal ? { signal } : {}), ...(options.fetch ? { fetch: options.fetch } : {}),
        onResponse: trace.onResponse
      });
      const parsed = v.parse(ReadingAnalysisSchema, result);
      const analysis = normalizeAnalysis(db, itemId, parsed, `${model.provider}/${model.id}`, { text, priorItems: readingContext.prior_items });
      await trace.success(analysis);
      return analysis;
    } catch (error) {
      await trace.error(error);
      throw new ApiError('ANALYSIS_FAILED', 'Reading analysis failed', 502, true, 30);
    }
  };
}

export function normalizeAnalysis(db: Database, itemId: string, result: ReadingAnalysis, model: string, evidenceContext: {
  text: string;
  priorItems: PriorReadingItem[];
}): Analysis {
  const themes = uniqueStrings(result.relevance.themes).slice(0, 12);
  const tags = result.tags
    .map((tag) => ({
      tag: tag.tag.trim().toLowerCase(),
      reason: tag.reason.trim().slice(0, 300) || 'Model reading judgment',
      confidence: clamp01(tag.confidence)
    }))
    .filter((tag) => tag.tag)
    .slice(0, 20);

  const suppliedItems = new Map(evidenceContext.priorItems.map((item) => [item.item_id, item]));
  const modelRelationships: Relationship[] = [];
  const seenRelationships = new Set<string>();
  for (const relationship of result.relationships) {
    const target = suppliedItems.get(relationship.to_item_id);
    const relationType = relationship.relation_type.trim();
    const sourceQuote = relationship.evidence?.source_quote.trim() ?? '';
    const targetQuote = relationship.evidence?.target_quote.trim() ?? '';
    // Existence is insufficient: the model can only cite the exact passages it saw.
    if (relationship.from_item_id !== itemId || relationship.to_item_id === itemId || !target
      || !(MODEL_RELATION_TYPES as readonly string[]).includes(relationType)
      || !sourceQuote || !targetQuote || sourceQuote.length > 1500 || targetQuote.length > 1500
      || !evidenceContext.text.includes(sourceQuote)
      || !target.source_passages.some((passage) => passage.includes(targetQuote))) continue;
    const key = `${relationship.to_item_id}:${relationType}`;
    if (seenRelationships.has(key)) continue;
    seenRelationships.add(key);
    modelRelationships.push(canonicalRelationship(itemId, target.item_id, {
      relation_type: relationType,
      explanation: relationship.explanation.trim().slice(0, 500) || 'Model reading relationship',
      confidence: clamp01(relationship.confidence),
      evidence: { source_quote: sourceQuote, target_quote: targetQuote },
      origin: 'model'
    }));
  }

  return {
    summary: result.summary.trim().slice(0, 1200) || 'No extractable summary.',
    claims: uniqueStrings(result.claims).slice(0, 8).map((claim) => claim.slice(0, 400)),
    relevance: {
      score: clamp01(result.relevance.score),
      themes
    },
    recommended_action: result.recommended_action,
    confidence: clamp01(result.confidence),
    reason: result.reason.trim().slice(0, 600) || 'Model reading judgment completed.',
    tags,
    relationships: (modelRelationships.length ? modelRelationships : findRelationships(db, itemId, themes)).slice(0, 3),
    model,
    analysis_version: READING_ANALYSIS_VERSION
  };
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
