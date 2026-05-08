import { promises as fs } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import { createFlueContext, type FlueContextConfig } from '@flue/sdk/client';
import { resolveModel } from '@flue/sdk/internal';
import { createSandboxSessionEnv, type SandboxApi } from '@flue/sdk/sandbox';
import type { Database } from '../db/connection.js';
import { SqliteSessionStore } from '../db/sqlite-session-store.js';
import { ApiError } from '../api/errors.js';
import type { Analysis } from './types.js';
import { canonicalRelationship, findRelationships } from './analyzer.js';
import { FlueTraceLogger } from './flue-trace.js';
import readingAgent from '../../.flue/agents/reading.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const WORKSPACE_ROOT = join(__dirname, '..', '..');
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
};

export type ReadingAnalyzer = (input: ReadingAnalyzerInput) => Promise<Analysis>;

/**
 * Wraps a Flue resolveModel with per-provider baseUrl overrides driven by env vars.
 *
 * Looks up `<PROVIDER>_BASE_URL` (uppercased provider, hyphens → underscores)
 * after the underlying resolver returns a Model. If set, returns a copy of the
 * Model with `baseUrl` replaced. Standard convention: this matches the env var
 * names used by the official Anthropic and OpenAI SDKs, so users with existing
 * proxy setups (Netflix's Claude Code gateway, Cloudflare AI Gateway, etc.)
 * can route Reading Memory's analysis traffic without forking pi-ai.
 *
 * Workaround: pi-ai pins baseUrl per model in its registry and does not consult
 * env. This wrapper applies the override after resolution so the override
 * survives across pi-ai upgrades.
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
    workspaceRoot?: string;
    resolveModel?: FlueContextConfig['agentConfig']['resolveModel'];
    tracePath?: string | null;
  }
): ReadingAnalyzer {
  const workspaceRoot = options.workspaceRoot ?? WORKSPACE_ROOT;
  const store = new SqliteSessionStore(db);
  const traces = new FlueTraceLogger(options.tracePath);
  // Default resolver wraps pi-ai's resolver with env-driven baseUrl overrides.
  // Caller-provided resolveModel (used by tests and special cases) bypasses
  // the wrapper and is honored as-is.
  const defaultResolver = wrapResolveModelWithBaseUrlOverrides(resolveModel);

  return async ({ itemId, title, text, sessionId }) => {
    const requestedSessionId = sessionId ?? `analysis:${itemId}`;
    const trace = traces.createTrace({
      itemId,
      sessionId: requestedSessionId,
      title,
      text,
      model: options.model
    });
    const context = createFlueContext({
      id: 'reading',
      payload: {
        item_id: itemId,
        title,
        text,
        model: options.model,
        session_id: requestedSessionId
      },
      env: process.env,
      agentConfig: {
        systemPrompt: '',
        skills: {},
        roles: {},
        model: undefined,
        resolveModel: options.resolveModel ?? defaultResolver,
        compaction: { enabled: true }
      },
      createDefaultEnv: async () => createSandboxSessionEnv(new SkillOnlySandbox(workspaceRoot), VIRTUAL_ROOT),
      createLocalEnv: async () => createSandboxSessionEnv(new SkillOnlySandbox(workspaceRoot), VIRTUAL_ROOT),
      defaultStore: store
    } satisfies FlueContextConfig);
    context.setEventCallback(trace.onEvent);

    try {
      const result = v.parse(FlueAnalysisSchema, await readingAgent(context));
      const analysis = normalizeAnalysis(db, itemId, result, options.model);
      await trace.success(analysis);
      return analysis;
    } catch (error) {
      await trace.error(error);
      throw new ApiError('ANALYSIS_FAILED', 'Flue reading analysis failed', 502, true, 30);
    }
  };
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

const ALLOWED_DIRS = new Set([
  '/',
  '/.agents',
  '/.agents/skills',
  '/.agents/skills/analyze-item'
]);
const ALLOWED_FILES = new Set([
  '/.agents/skills/analyze-item/SKILL.md'
]);

class SkillOnlySandbox implements SandboxApi {
  constructor(private readonly workspaceRoot: string) {}

  async readFile(path: string): Promise<string> {
    const virtual = this.virtualPath(path);
    if (!ALLOWED_FILES.has(virtual)) throw new Error('Reading API Flue sandbox only exposes the analyze-item skill.');
    return await fs.readFile(this.realPath(virtual), 'utf8');
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const virtual = this.virtualPath(path);
    if (!ALLOWED_FILES.has(virtual)) throw new Error('Reading API Flue sandbox only exposes the analyze-item skill.');
    return await fs.readFile(this.realPath(virtual));
  }

  async writeFile(): Promise<void> {
    throw new Error('Reading API Flue sandbox is skill-only.');
  }

  async stat(path: string) {
    const virtual = this.virtualPath(path);
    this.assertAllowed(virtual);
    const stat = await fs.lstat(this.realPath(virtual));
    return {
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      isSymbolicLink: stat.isSymbolicLink(),
      size: stat.size,
      mtime: stat.mtime
    };
  }

  async readdir(path: string): Promise<string[]> {
    const virtual = this.virtualPath(path);
    if (!ALLOWED_DIRS.has(virtual)) throw new Error('Reading API Flue sandbox only exposes the analyze-item skill.');
    if (virtual === '/') return ['.agents'];
    if (virtual === '/.agents') return ['skills'];
    if (virtual === '/.agents/skills') return ['analyze-item'];
    if (virtual === '/.agents/skills/analyze-item') return ['SKILL.md'];
    return [];
  }

  async exists(path: string): Promise<boolean> {
    const virtual = this.virtualPath(path);
    if (!ALLOWED_DIRS.has(virtual) && !ALLOWED_FILES.has(virtual)) return false;
    try {
      await fs.access(this.realPath(virtual));
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(): Promise<void> {
    throw new Error('Reading API Flue sandbox is skill-only.');
  }

  async rm(): Promise<void> {
    throw new Error('Reading API Flue sandbox is skill-only.');
  }

  async exec() {
    return {
      stdout: '',
      stderr: 'Reading API Flue sandbox does not allow command execution.',
      exitCode: 126
    };
  }

  private virtualPath(path: string) {
    const suffix = path.startsWith(VIRTUAL_ROOT) ? path.slice(VIRTUAL_ROOT.length) : path;
    return posix.normalize(`/${suffix}`);
  }

  private realPath(virtualPath: string) {
    this.assertAllowed(virtualPath);
    return join(this.workspaceRoot, virtualPath.slice(1));
  }

  private assertAllowed(virtualPath: string) {
    if (!ALLOWED_DIRS.has(virtualPath) && !ALLOWED_FILES.has(virtualPath)) {
      throw new Error('Reading API Flue sandbox only exposes the analyze-item skill.');
    }
  }
}
