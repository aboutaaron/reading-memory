import { appendFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { FlueEvent } from '@flue/sdk/client';
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
  | (TraceBase & {
      event: 'flue_event';
      flue_type: FlueEvent['type'];
      session_id?: string;
      parent_session_id?: string;
      task_id?: string;
      text_chars?: number;
      tool_name?: string;
      tool_call_id?: string;
      args_keys?: string[];
      is_error?: boolean;
      result_summary?: string;
      command_chars?: number;
      command_sha256?: string;
      command_args_count?: number;
      exit_code?: number;
      error_kind?: string;
      error_message_chars?: number;
      error_message_sha256?: string;
    })
  | (TraceBase & {
      event: 'analysis_success';
      duration_ms: number;
      recommended_action: Analysis['recommended_action'];
      confidence: number;
      relevance_score: number;
      themes: string[];
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

type FlueEventTraceSummary = Omit<Extract<FlueTraceEvent, { event: 'flue_event' }>, keyof TraceBase>;

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
      onEvent: (event: FlueEvent) => {
        void this.write({
          ...base,
          ...summarizeFlueEvent(event),
          ts: now()
        });
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
          themes: analysis.relevance.themes,
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
      }
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
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      event: 'reading-api.flue_trace_write_failed',
      trace_path: this.path,
      error_kind: errorKind(error)
    }));
  }
}

function summarizeFlueEvent(event: FlueEvent): FlueEventTraceSummary {
  const base: FlueEventTraceSummary = {
    event: 'flue_event' as const,
    flue_type: event.type
  };
  addDefined(base, 'session_id', event.sessionId);
  addDefined(base, 'parent_session_id', event.parentSessionId);
  addDefined(base, 'task_id', event.taskId);

  switch (event.type) {
    case 'text_delta':
      return { ...base, text_chars: event.text.length };
    case 'tool_start':
      return {
        ...base,
        tool_name: event.toolName,
        tool_call_id: event.toolCallId,
        args_keys: event.args && typeof event.args === 'object' ? Object.keys(event.args).sort() : []
      };
    case 'tool_end':
      return {
        ...base,
        tool_name: event.toolName,
        tool_call_id: event.toolCallId,
        is_error: event.isError,
        result_summary: summarizeValue(event.result)
      };
    case 'command_start':
      return {
        ...base,
        command_chars: event.command.length,
        command_sha256: sha256(event.command),
        command_args_count: event.args.length
      };
    case 'command_end':
      return {
        ...base,
        command_chars: event.command.length,
        command_sha256: sha256(event.command),
        exit_code: event.exitCode
      };
    case 'task_start':
      return { ...base, task_id: event.taskId };
    case 'task_end':
      return { ...base, task_id: event.taskId, is_error: event.isError, result_summary: summarizeValue(event.result) };
    case 'error':
      return { ...base, ...summarizeError(event.error) };
    default:
      return base;
  }
}

function summarizeValue(value: unknown) {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return `${value.length} chars`;
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') return `object(${Object.keys(value).sort().join(',')})`;
  return typeof value;
}

function summarizeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    error_kind: errorKind(error),
    error_message_chars: message.length,
    error_message_sha256: sha256(message)
  };
}

function errorKind(error: unknown) {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  if (error instanceof Error) return error.name;
  return typeof error;
}

function addDefined<T extends object, K extends string, V>(target: T, key: K, value: V | undefined): asserts target is T & Record<K, V> {
  if (value !== undefined) Object.assign(target, { [key]: value });
}

function sha256(text: string) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function now() {
  return new Date().toISOString();
}
