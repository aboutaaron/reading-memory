import { appendFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { sha256 } from '../ingest/content-hash.js';
import type { Analysis } from './types.js';

type TraceBase = {
  trace_id: string;
  item_id: string;
  requested_session_id: string;
  ts: string;
};

export type FlueTraceEvent =
  | (TraceBase & {
      event: 'analysis_start';
      title_chars: number | null;
      title_sha256: string | null;
      text_chars: number;
      text_sha256: string;
      model: string;
    })
  | (TraceBase & ProviderResponseMetadata & { event: 'provider_response' })
  | (TraceBase & {
      event: 'analysis_success';
      duration_ms: number;
      recommended_action: Analysis['recommended_action'];
      confidence: number;
      relevance_score: number;
      theme_count: number;
      tag_count: number;
      relationship_count: number;
      model: string;
      analysis_version: string;
    })
  | (TraceBase & {
      event: 'analysis_error';
      duration_ms: number;
      error_kind: string;
      error_message_chars: number;
      error_message_sha256: string;
    });

export type ProviderResponseMetadata = { provider: 'openai' | 'anthropic'; output_chars: number; input_tokens: number; output_tokens: number };

export class FlueTraceLogger {
  private ready: Promise<void> | null = null;
  private pending: Promise<void> = Promise.resolve();
  private warned = false;

  constructor(private readonly path: string | null | undefined) {}

  get enabled() {
    return Boolean(this.path);
  }

  createTrace(input: { itemId: string; sessionId: string; title: string | null; text: string; model: string }) {
    const startedAt = Date.now();
    const base = {
      trace_id: randomUUID(),
      item_id: input.itemId,
      requested_session_id: input.sessionId
    };

    void this.write({
      ...base,
      ts: now(),
      event: 'analysis_start',
      title_chars: input.title?.length ?? null,
      title_sha256: input.title ? sha256(input.title) : null,
      text_chars: input.text.length,
      text_sha256: sha256(input.text),
      model: input.model
    });

    return {
      traceId: base.trace_id,
      onResponse: (metadata: ProviderResponseMetadata) => {
        void this.write({ ...base, ts: now(), event: 'provider_response',
          provider: metadata.provider === 'anthropic' ? 'anthropic' : 'openai',
          output_chars: safeCount(metadata.output_chars), input_tokens: safeCount(metadata.input_tokens),
          output_tokens: safeCount(metadata.output_tokens) });
      },
      success: async (analysis: Analysis) => {
        await this.write({
          ...base,
          ts: now(),
          event: 'analysis_success',
          duration_ms: Date.now() - startedAt,
          recommended_action: analysis.recommended_action,
          confidence: analysis.confidence,
          relevance_score: analysis.relevance.score,
          theme_count: analysis.relevance.themes.length,
          tag_count: analysis.tags.length,
          relationship_count: analysis.relationships.length,
          model: analysis.model,
          analysis_version: analysis.analysis_version
        });
      },
      error: async (error: unknown) => {
        await this.write({
          ...base,
          ts: now(),
          event: 'analysis_error',
          duration_ms: Date.now() - startedAt,
          ...summarizeError(error)
        });
      },
      flush: () => this.pending
    };
  }

  private async write(event: FlueTraceEvent) {
    if (!this.path) return;
    const write = async () => {
      this.ready ??= mkdir(dirname(this.path!), { recursive: true }).then(() => undefined);
      await this.ready;
      await appendFile(this.path!, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    };
    this.pending = this.pending.then(write, write).catch((error: unknown) => {
      this.warn(error);
    });
    await this.pending;
  }

  private warn(error: unknown) {
    if (this.warned) return;
    this.warned = true;
    console.error(JSON.stringify({
      event: 'reading-api.flue_trace_write_failed',
      trace_path: this.path,
      error_kind: errorKind(error)
    }));
  }
}

function summarizeError(error: unknown) {
  const message = errorMessage(error);
  return {
    error_kind: errorKind(error),
    error_message_chars: message.length,
    error_message_sha256: sha256(message)
  };
}

/** Only fixed, known operational identifiers are safe to persist verbatim.
 * Provider-controlled code/name/type values are otherwise hashed. */
const SAFE_ERROR_KINDS = new Set([
  'AbortError',
  'AggregateError',
  'EACCES',
  'ECONNREFUSED',
  'ECONNRESET',
  'EEXIST',
  'ENOENT',
  'EPERM',
  'ETIMEDOUT',
  'Error',
  'RangeError',
  'ReferenceError',
  'RUN_FAILED',
  'SubmissionError',
  'SyntaxError',
  'TypeError',
  'URIError'
]);

function errorKind(error: unknown) {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as Record<string, unknown>;
    for (const key of ['code', 'name', 'type'] as const) {
      const value = candidate[key];
      if (typeof value === 'string' && value.length > 0) {
        return SAFE_ERROR_KINDS.has(value) ? value : sha256(value);
      }
    }
  }
  if (error instanceof Error) return SAFE_ERROR_KINDS.has(error.name) ? error.name : sha256(error.name);
  return typeof error;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

function safeCount(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function now() {
  return new Date().toISOString();
}
