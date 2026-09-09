import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { openMemoryDatabase } from '../db/connection.js';
import { MODEL_RELATION_TYPES, normalizeAnalysis, READING_ANALYSIS_VERSION } from '../reading/flue-agent.js';
import { prepareProviderAnalysisInput, resolveProviderAnalysisOutput } from '../reading/passage-evidence.js';
import { requestReadingAnalysis } from '../reading/provider-analysis.js';
import { resolveProviderModel } from '../reading/provider-model.js';
import { READING_ANALYSIS_INSTRUCTIONS } from '../reading/analysis-prompt.js';
import { readingAnalysisJsonSchema } from '../reading/analysis-schema.js';
import type { ProviderResponseMetadata } from '../reading/flue-trace.js';

const id = z.string().min(1).max(200);
const annotation = z.object({ id, actor_type: z.enum(['user', 'agent']), actor: z.string().max(120),
  note: z.string().max(700), project: z.string().max(120).nullable(), question: z.string().max(300).nullable(),
  created_at: z.string().max(100) }).strict();
const prior = z.object({ item_id: id, title: z.string().max(240).nullable(), summary: z.string().max(800),
  tags: z.array(z.string().max(80)).max(12), source_passages: z.array(z.string().min(1).max(800)).max(3),
  annotations: z.array(annotation).max(3) }).strict();
const expectedEdge = z.object({ to_item_id: id, relation_type: z.enum(MODEL_RELATION_TYPES) }).strict();
const comparisonCase = z.object({
  case_id: id,
  cohort: z.enum(['representative', 'held_out', 'repair', 'synthetic']),
  input: z.object({ item_id: id, title: z.string().max(1000).nullable(), text: z.string().min(1).max(100_000),
    reader_context: z.object({ source_context: z.string().max(1000).nullable(), ingest_reason: z.string().max(1000).nullable(),
      annotations: z.array(annotation).max(3) }).strict(), prior_items: z.array(prior).max(5) }).strict(),
  // Labels are frozen before requests. Empty means a labelled no-edge case; null means unlabelled.
  expected_edges: z.array(expectedEdge).max(30).nullable(),
  source_families: z.record(z.string(), z.string().min(1).max(200)).optional()
}).strict().superRefine((value, ctx) => {
  const targets = new Set(value.input.prior_items.map(item => item.item_id));
  if (targets.size !== value.input.prior_items.length || targets.has(value.input.item_id)) {
    ctx.addIssue({ code: 'custom', message: 'Prior IDs must be unique and exclude the current item.' });
  }
  const keys = (value.expected_edges ?? []).map(edge => `${edge.to_item_id}\0${edge.relation_type}`);
  if (new Set(keys).size !== keys.length || value.expected_edges?.some(edge => !targets.has(edge.to_item_id))) {
    ctx.addIssue({ code: 'custom', message: 'Expected edges must be unique and point to supplied prior items.' });
  }
  if (value.source_families && Object.keys(value.source_families).some(key => key !== value.input.item_id && !targets.has(key))) {
    ctx.addIssue({ code: 'custom', message: 'Source families must identify supplied items.' });
  }
});
export const ComparisonManifestSchema = z.object({ version: z.literal(1), cases: z.array(comparisonCase).min(1).max(25) })
  .strict().refine(value => new Set(value.cases.map(item => item.case_id)).size === value.cases.length,
    { message: 'Case IDs must be unique.' });
export type ComparisonManifest = z.infer<typeof ComparisonManifestSchema>;

export function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function validateModels(models: readonly string[]): asserts models is [string, string] {
  if (models.length !== 2 || models[0] === models[1] || models.some(model => !/^(openai|anthropic)\/[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(model))) {
    throw new Error('Supply two different, explicit provider/model IDs.');
  }
}

export type ComparisonOptions = {
  models: [string, string];
  apply?: boolean;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** Deterministic testing seam; real calls always use the existing provider boundary. */
  request?: typeof requestReadingAnalysis;
};

/** No corpus database is accepted or opened. Every arm sees the same prepared input. */
export async function compareAnalyzers(manifest: ComparisonManifest, options: ComparisonOptions) {
  const validated = ComparisonManifestSchema.parse(manifest);
  validateModels(options.models);
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 55_000) {
    throw new Error('Timeout must be between 1000 and 55000 milliseconds.');
  }
  const prepared = validated.cases.map(item => prepareProviderAnalysisInput(item.input));
  const base = { version: 1, analysis_version: READING_ANALYSIS_VERSION,
    instructions_sha256: sha256Json(READING_ANALYSIS_INSTRUCTIONS), schema_sha256: sha256Json(readingAnalysisJsonSchema),
    manifest_sha256: sha256Json(validated),
    models: options.models, cases: validated.cases.length, planned_calls: validated.cases.length * 2,
    timeout_ms: options.timeoutMs, input_sha256: prepared.map(sha256Json),
    semantic_review: 'required_separately', estimated_cost: null };
  if (!options.apply) return { ...base, dry_run: true, completed_calls: 0, failed_calls: 0, results: [] };
  // Resolve both arms before making any request. Never persist this object (it contains keys).
  const models = options.models.map(model => resolveProviderModel(model, options.env));
  const request = options.request ?? requestReadingAnalysis;
  const db = openMemoryDatabase();
  const results = [];
  try {
    for (const [caseIndex, item] of validated.cases.entries()) {
      // Alternate order without altering context or expected labels.
      for (const arm of caseIndex % 2 === 0 ? [0, 1] : [1, 0]) {
        const started = performance.now();
        let metadata: ProviderResponseMetadata | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const controller = new AbortController();
        let timedOut = false;
        const common = { case_id: item.case_id, cohort: item.cohort, model: options.models[arm],
          input_sha256: base.input_sha256[caseIndex], expected_edges: item.expected_edges,
          source_families: item.source_families ?? null };
        try {
          const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
            timedOut = true; controller.abort(); reject(new Error('Comparison timeout'));
          }, options.timeoutMs); });
          const raw = await Promise.race([request(models[arm]!, structuredClone(prepared[caseIndex]!), {
            signal: controller.signal, onResponse: value => { metadata = value; }
          }), timeout]);
          const resolved = resolveProviderAnalysisOutput(raw, prepared[caseIndex]!);
          const analysis = normalizeAnalysis(db, item.input.item_id, resolved, options.models[arm]!, {
            text: item.input.text, priorItems: item.input.prior_items
          });
          const edges = analysis.relationships.filter(edge => edge.origin === 'model');
          const rawCount = (raw as { relationships: unknown[] }).relationships.length;
          const validQuotes = edges.filter(edge => edge.evidence && item.input.text.includes(edge.evidence.source_quote)
            && item.input.prior_items.find(priorItem => priorItem.item_id === edge.to_item_id)?.source_passages
              .some(passage => passage.includes(edge.evidence!.target_quote))).length;
          const key = (edge: { to_item_id: string; relation_type: string }) => `${edge.to_item_id}\0${edge.relation_type}`;
          const predicted = new Set(edges.map(key));
          const expected = item.expected_edges === null ? null : new Set(item.expected_edges.map(key));
          const correct = expected === null ? null : [...predicted].filter(value => expected.has(value)).length;
          results.push({ ...common, status: 'completed', latency_ms: Math.round(performance.now() - started),
            usage: usage(metadata), cost: null, proposed_edges: rawCount,
            valid_reference_edges: resolved.relationships.length,
            rejected_reference_edges: rawCount - resolved.relationships.length,
            accepted_edges: edges.length, exact_quote_pairs: validQuotes,
            expected_edge_matches: correct, expected_edge_count: expected?.size ?? null,
            missing_expected_edges: expected === null ? null : expected.size - correct!,
            edge_precision: expected === null || predicted.size === 0 ? null : correct! / predicted.size,
            edge_recall: expected === null || expected.size === 0 ? null : correct! / expected.size,
            false_positive_edges: expected === null ? null : predicted.size - correct!,
            source_family_label_agreement: sourceFamilyLabelAgreement(item, edges),
            analysis });
        } catch {
          results.push({ ...common, status: timedOut ? 'timeout' : 'provider_or_validation_failed',
            latency_ms: Math.round(performance.now() - started), usage: usage(metadata), cost: null });
        } finally { if (timer) clearTimeout(timer); }
      }
    }
  } finally { db.close(); }
  return { ...base, dry_run: false, completed_calls: results.filter(result => result.status === 'completed').length,
    failed_calls: results.filter(result => result.status !== 'completed').length, results };
}

/** Family counts measure agreement with frozen labels, not semantic truth. Requiring a
 * complete supplied-item map avoids silently treating unknown aliases as independent.
 */
function sourceFamilyLabelAgreement(item: ComparisonManifest['cases'][number], edges: Array<{ to_item_id: string; relation_type: string }>) {
  const families = item.source_families;
  if (item.expected_edges === null || !families
    || [item.input.item_id, ...item.input.prior_items.map(prior => prior.item_id)].some(id => !families[id])) return null;
  const key = (edge: { to_item_id: string; relation_type: string }) => `${edge.to_item_id}\0${edge.relation_type}`;
  const expectedKeys = new Set(item.expected_edges.map(key));
  const expectedFamilies = new Set(item.expected_edges.map(edge => families[edge.to_item_id]!));
  const predictedFamilies = new Set(edges.map(edge => families[edge.to_item_id]!));
  const matchedFamilies = new Set(edges.filter(edge => expectedKeys.has(key(edge))).map(edge => families[edge.to_item_id]!));
  const currentFamily = families[item.input.item_id]!;
  const independent = (values: Set<string>) => new Set([...values].filter(family => family !== currentFamily));
  const expectedIndependent = independent(expectedFamilies);
  const predictedIndependent = independent(predictedFamilies);
  const matchedIndependent = independent(matchedFamilies);
  return {
    unique_expected_target_families: expectedFamilies.size,
    unique_predicted_target_families: predictedFamilies.size,
    unique_matched_target_families: matchedFamilies.size,
    missing_expected_target_families: expectedFamilies.size - matchedFamilies.size,
    target_family_recall: expectedFamilies.size ? matchedFamilies.size / expectedFamilies.size : null,
    unique_expected_independent_target_families: expectedIndependent.size,
    unique_predicted_independent_target_families: predictedIndependent.size,
    unique_matched_independent_target_families: matchedIndependent.size,
    missing_expected_independent_target_families: expectedIndependent.size - matchedIndependent.size,
    independent_target_family_recall: expectedIndependent.size ? matchedIndependent.size / expectedIndependent.size : null
  };
}

function usage(metadata: ProviderResponseMetadata | undefined) {
  // The existing boundary supplies zero when optional provider usage is absent.
  // Report unknown rather than claiming a free call in that ambiguous case.
  if (!metadata || metadata.input_tokens + metadata.output_tokens === 0) return null;
  return { input_tokens: metadata.input_tokens, output_tokens: metadata.output_tokens };
}
