import * as v from 'valibot';
import { createSandboxSessionEnv, type SandboxApi } from '@flue/runtime';
import {
  createFlueContext,
  resolveModel,
  type FlueContextConfig
} from '@flue/runtime/internal';
import type { Database } from '../db/connection.js';
import { ApiError } from '../api/errors.js';
import type { Analysis } from './types.js';
import { canonicalRelationship, findRelationships } from './analyzer.js';
import { FlueTraceLogger } from './flue-trace.js';
import { analyzeItemSkill, createReadingAgent } from './flue-reading-agent.js';

const VIRTUAL_ROOT = '/workspace';

const FlueAnalysisSchema = v.object({
  summary: v.string(),
  claims: v.array(v.string()),
  relevance: v.object({
    score: v.number(),
    themes: v.array(v.string())
  }),
  recommended_action: v.picklist(['brief', 'save', 'skip']),
  confidence: v.number(),
  reason: v.string(),
  tags: v.array(v.object({
    tag: v.string(),
    reason: v.string(),
    confidence: v.number()
  })),
  relationships: v.array(v.object({
    from_item_id: v.string(),
    to_item_id: v.string(),
    relation_type: v.string(),
    explanation: v.string(),
    confidence: v.number()
  }))
});

type FlueAnalysis = v.InferOutput<typeof FlueAnalysisSchema>;

export type ReadingAnalyzerInput = {
  itemId: string;
  title: string | null;
  text: string;
  sessionId?: string;
  /** Cancels the in-flight analysis (e.g. request deadline). Passed through to `session.skill()`. */
  signal?: AbortSignal;
};

export type ReadingAnalyzer = (input: ReadingAnalyzerInput) => Promise<Analysis>;

export type AnalyzerHealth = {
  status: 'ok' | 'unavailable';
  warn: boolean;
};

export function flueAnalyzerHealth(): AnalyzerHealth {
  return { status: 'ok', warn: false };
}

/**
 * Wraps Flue's model resolver with per-provider baseUrl overrides driven by env vars.
 */
export function wrapResolveModelWithBaseUrlOverrides(
  base: NonNullable<FlueContextConfig['agentConfig']['resolveModel']>
): NonNullable<FlueContextConfig['agentConfig']['resolveModel']> {
  return (modelString: string) => {
    const resolved = base(modelString);
    if (!resolved || typeof resolved !== 'object') return resolved;
    const provider = (resolved as { provider?: unknown }).provider;
    if (typeof provider !== 'string' || provider.length === 0) return resolved;
    const envKey = `${provider.toUpperCase().replace(/-/g, '_')}_BASE_URL`;
    const override = process.env[envKey];
    if (!override) return resolved;
    return { ...resolved, baseUrl: override };
  };
}

export function createFlueReadingAnalyzer(
  db: Database,
  options: {
    model: string;
    resolveModel?: FlueContextConfig['agentConfig']['resolveModel'];
    tracePath?: string | null;
  }
): ReadingAnalyzer {
  const traces = new FlueTraceLogger(options.tracePath);
  const defaultResolver = wrapResolveModelWithBaseUrlOverrides(resolveModel);
  const modelResolver = options.resolveModel ?? defaultResolver;
  const agent = createReadingAgent(options.model);

  return async ({ itemId, title, text, sessionId, signal }) => {
    const requestedSessionId = sessionId ?? `analysis:${itemId}`;
    const trace = traces.createTrace({
      itemId,
      sessionId: requestedSessionId,
      title,
      text,
      model: options.model
    });
    const context = createFlueContext({
      id: requestedSessionId,
      agentName: 'reading',
      env: process.env,
      agentConfig: { resolveModel: modelResolver },
      createDefaultEnv: async () => createSandboxSessionEnv(new AnalysisSandbox(), VIRTUAL_ROOT)
    });
    context.setEventCallback(trace.onEvent);

    try {
      const harness = await context.initializeRootHarness(agent);
      let result: FlueAnalysis;
      try {
        const session = await harness.session();
        const response = await session.skill(analyzeItemSkill, {
          args: {
            item_id: itemId,
            title,
            text
          },
          result: FlueAnalysisSchema,
          ...(signal ? { signal } : {})
        });
        result = response.data;
      } finally {
        await harness.close();
        await context.flushEventCallbacks();
      }
      const analysis = normalizeAnalysis(db, itemId, result, options.model);
      await trace.success(analysis);
      return analysis;
    } catch (error) {
      await trace.error(error);
      throw new ApiError('ANALYSIS_FAILED', 'Flue reading analysis failed', 502, true, 30);
    }
  };
}

class AnalysisSandbox implements SandboxApi {
  async readFile(): Promise<string> {
    throw new Error('Reading Memory analysis sandbox does not expose files.');
  }

  async readFileBuffer(): Promise<Uint8Array> {
    throw new Error('Reading Memory analysis sandbox does not expose files.');
  }

  async writeFile(): Promise<void> {
    throw new Error('Reading Memory analysis sandbox is read-only.');
  }

  async stat(): Promise<never> {
    throw new Error('Reading Memory analysis sandbox does not expose files.');
  }

  async readdir(): Promise<string[]> {
    return [];
  }

  async exists(): Promise<boolean> {
    return false;
  }

  async mkdir(): Promise<void> {
    throw new Error('Reading Memory analysis sandbox is read-only.');
  }

  async rm(): Promise<void> {
    throw new Error('Reading Memory analysis sandbox is read-only.');
  }

  async exec() {
    return {
      stdout: '',
      stderr: 'Reading Memory analysis sandbox does not allow command execution.',
      exitCode: 126
    };
  }
}

function normalizeAnalysis(db: Database, itemId: string, result: FlueAnalysis, model: string): Analysis {
  const themes = uniqueStrings(result.relevance.themes).slice(0, 12);
  const tags = result.tags
    .map((tag) => ({
      tag: tag.tag.trim().toLowerCase(),
      reason: tag.reason.trim().slice(0, 300) || 'Flue reading judgment',
      confidence: clamp01(tag.confidence)
    }))
    .filter((tag) => tag.tag)
    .slice(0, 20);

  const modelRelationships = result.relationships
    .filter((relationship) => relationship.to_item_id && relationship.to_item_id !== itemId && itemExists(db, relationship.to_item_id))
    .map((relationship) => canonicalRelationship(itemId, relationship.to_item_id, {
      relation_type: relationship.relation_type.trim() || 'related',
      explanation: relationship.explanation.trim().slice(0, 500) || 'Flue reading relationship',
      confidence: clamp01(relationship.confidence)
    }));

  return {
    summary: result.summary.trim().slice(0, 1200) || 'No extractable summary.',
    claims: uniqueStrings(result.claims).slice(0, 8).map((claim) => claim.slice(0, 400)),
    relevance: {
      score: clamp01(result.relevance.score),
      themes
    },
    recommended_action: result.recommended_action,
    confidence: clamp01(result.confidence),
    reason: result.reason.trim().slice(0, 600) || 'Flue reading judgment completed.',
    tags,
    relationships: [...modelRelationships, ...findRelationships(db, itemId, themes)].slice(0, 3),
    model,
    analysis_version: 'reading-api-flue-v1'
  };
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function itemExists(db: Database, itemId: string) {
  return Boolean(db.prepare("SELECT 1 AS ok FROM items WHERE id = ? AND status = 'indexed'").get(itemId));
}
