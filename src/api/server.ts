import { createEmbeddingProvider } from '../reading/embedding-provider.js';
import { embedAnalysis, embeddingHealth, vectorNeighbors, type Embedder } from '../reading/embeddings.js';
import { queryHybridCorpus } from '../reading/hybrid-query.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import type { AppConfig } from '../config.js';
import { LIMITS } from '../config.js';
import type { Database } from '../db/connection.js';
import { ApiError, toErrorPayload } from './errors.js';
import { requireAuth } from './auth.js';
import { RateLimiter } from './rate-limit.js';
import { AnnotationRequestSchema, BriefEventsRequestSchema, BriefGuideRequestSchema, IngestRequestSchema, QueryRequestSchema, ReanalyzeRequestSchema, RequestIdSchema } from './contracts.js';
import { ItemStore } from '../reading/item-store.js';
import {
  READING_ANALYSIS_VERSION,
  createFlueReadingAnalyzer,
  flueAnalyzerHealth,
  type AnalyzerHealth,
  type ReadingAnalyzer,
  type ReadingAnalyzerInput
} from '../reading/flue-agent.js';
import { extractSource, payloadHash } from '../reading/extract-source.js';
import { PDF_PARSE_LIMITS } from '../ingest/extract-pdf.js';
import { briefGuide } from '../reading/brief-guide.js';
import { getItem, queryCorpus } from '../reading/corpus-query.js';
import { BriefEventStore, briefEventsPayloadHash } from '../reading/brief-events.js';
import { analysisFreshness, listStaleItems } from '../reading/analysis-freshness.js';
import { ReaderAnnotationStore } from '../reading/reader-annotations.js';
import { observeRequest, type RequestOutcomeLogger } from './request-outcomes.js';

export function createReadingApi(
  config: AppConfig,
  db: Database,
  options: { embedder?: Embedder | null; analyzer?: ReadingAnalyzer; analyzerHealth?: () => AnalyzerHealth; extractor?: typeof extractSource; requestLogger?: RequestOutcomeLogger | null } = {}
) {
  const limiter = new RateLimiter({ ingest: 10, query: 30, brief: 10, annotation: 30 });
  const store = new ItemStore(db);
  const briefEventStore = new BriefEventStore(db);
  const annotations = new ReaderAnnotationStore(db);
  const extractor = options.extractor ?? extractSource;
  const embedder = options.embedder === undefined ? createEmbeddingProvider(config.embeddingModel) : options.embedder;
  const baseAnalyzer = options.analyzer ?? createFlueReadingAnalyzer(db, { model: config.flueModel, tracePath: config.flueTracePath });
  const analyzer = createEmbeddingReadingAnalyzer(db, baseAnalyzer, embedder);
  const analyzerHealth = options.analyzerHealth ?? (options.analyzer
    ? () => ({ status: 'ok' as const, warn: false })
    : () => flueAnalyzerHealth(config.flueModel));

  const requestLogger = options.requestLogger === undefined
    ? (outcome: Parameters<RequestOutcomeLogger>[0]) => console.log(JSON.stringify(outcome))
    : options.requestLogger;
  return createServer(async (req, res) => {
    const outcome = observeRequest(req, res, requestLogger);
    let requestId = req.headers['x-request-id']?.toString() ?? null;
    const readRequestBody = async () => {
      const raw = await readJson(req);
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const id = v.safeParse(RequestIdSchema, (raw as Record<string, unknown>).request_id);
        if (id.success) requestId = id.output;
      }
      return raw;
    };

    try {
      assertAllowedHost(req, config);
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      outcome.route(url.pathname);
      setSecurityHeaders(res);

      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true, request_id: requestId, data: { ...health(db, config, analyzerHealth()), embeddings: embeddingHealth(db, embedder?.model ?? null) }, error: null });
      }

      const principal = requireAuth(req, config.authToken);

      if (req.method === 'GET' && url.pathname === '/capabilities') {
        return send(res, 200, { ok: true, request_id: requestId, data: capabilities(), error: null });
      }

      if (req.method === 'POST' && url.pathname === '/ingest') {
        limiter.check(principal, 'ingest');
        const deadline = Date.now() + LIMITS.maxSyncResponseSeconds * 1000;
        const raw = await readRequestBody();
        const body = v.parse(IngestRequestSchema, raw);
        const response = await store.ingest({
          principal,
          requestId: body.request_id,
          payloadHash: payloadHash(body),
          extract: () => withTimeout((signal) => extractor(body, signal), remainingMs(deadline)),
          analyze: (itemId, source) => withTimeout(
            (signal) => analyzer({ itemId, title: source.title, text: source.extractedText,
              readerContext: { source_context: body.source_context ?? null, ingest_reason: body.ingest_reason ?? null },
              sessionId: `analysis:${itemId}:${body.request_id}`, signal, deadline }),
            remainingMs(deadline)
          )
        });
        return send(res, 200, { ok: true, request_id: body.request_id, data: response, error: null });
      }

      if (req.method === 'POST' && url.pathname === '/query') {
        limiter.check(principal, 'query');
        const body = v.parse(QueryRequestSchema, await readRequestBody());
        const queryInput: Parameters<typeof queryCorpus>[1] = { query: body.query };
        if (body.mode !== undefined && body.mode !== 'hybrid') queryInput.mode = body.mode;
        if (body.lexical_policy !== undefined) queryInput.lexical_policy = body.lexical_policy;
        if (body.top_k !== undefined) queryInput.topK = body.top_k;
        if (body.filters?.since !== undefined) queryInput.since = body.filters.since;
        if (body.filters?.tags !== undefined) queryInput.tags = body.filters.tags;
        const data = body.mode === 'hybrid' ? await queryHybridCorpus(db, queryInput, embedder) : queryCorpus(db, queryInput);
        return send(res, 200, { ok: true, request_id: body.request_id, data, error: null });
      }

      if (req.method === 'POST' && url.pathname === '/brief-guide') {
        limiter.check(principal, 'brief');
        const body = v.parse(BriefGuideRequestSchema, await readRequestBody());
        const briefInput: Parameters<typeof briefGuide>[1] = { briefDate: body.brief_date };
        if (body.lookback_hours !== undefined) briefInput.lookbackHours = body.lookback_hours;
        if (body.focus !== undefined) briefInput.focus = body.focus;
        const data = briefGuide(db, briefInput);
        return send(res, 200, { ok: true, request_id: body.request_id, data, error: null });
      }

      if (req.method === 'POST' && url.pathname === '/brief-events') {
        limiter.check(principal, 'brief');
        const body = v.parse(BriefEventsRequestSchema, await readRequestBody());
        const data = briefEventStore.record({
          principal,
          requestId: body.request_id,
          payloadHash: briefEventsPayloadHash(body),
          body
        });
        return send(res, 200, { ok: true, request_id: body.request_id, data, error: null });
      }

      if (req.method === 'GET' && url.pathname === '/items') {
        limiter.check(principal, 'query');
        const limits = url.searchParams.getAll('limit');
        const limit = limits.length ? Number(limits[0]) : 25;
        if (url.searchParams.getAll('stale').length !== 1 || url.searchParams.get('stale') !== 'true'
          || limits.length > 1 || !Number.isInteger(limit) || limit < 1 || limit > 100
          || [...url.searchParams.keys()].some((key) => !['stale', 'limit'].includes(key))) {
          throw new ApiError('BAD_REQUEST', 'Use stale=true and an optional limit from 1 to 100', 400);
        }
        const data = listStaleItems(db, READING_ANALYSIS_VERSION, config.flueModel, limit);
        return send(res, 200, { ok: true, request_id: requestId, data, error: null });
      }

      const reanalyzeMatch = /^\/items\/([^/]+)\/reanalyze$/.exec(url.pathname);
      if (req.method === 'POST' && reanalyzeMatch?.[1]) {
        limiter.check(principal, 'ingest');
        const deadline = Date.now() + LIMITS.maxSyncResponseSeconds * 1000;
        const body = v.parse(ReanalyzeRequestSchema, await readRequestBody());
        const data = await store.reanalyze({ principal, requestId: body.request_id, itemId: reanalyzeMatch[1],
          analyze: (itemId, source) => withTimeout((signal) => analyzer({ itemId, title: source.title, text: source.extractedText,
            readerContext: {
              source_context: typeof source.provenance.source_context === 'string' ? source.provenance.source_context : null,
              ingest_reason: typeof source.provenance.ingest_reason === 'string' ? source.provenance.ingest_reason : null
            }, sessionId: `analysis:${itemId}:${body.request_id}`, signal, deadline }), remainingMs(deadline)) });
        return send(res, 200, { ok: true, request_id: body.request_id, data, error: null });
      }

      const annotationMatch = /^\/items\/([^/]+)\/annotations$/.exec(url.pathname);
      if (req.method === 'POST' && annotationMatch?.[1]) {
        limiter.check(principal, 'annotation');
        const body = v.parse(AnnotationRequestSchema, await readRequestBody());
        const data = annotations.record({ principal, requestId: body.request_id, itemId: annotationMatch[1], body });
        return send(res, 200, { ok: true, request_id: body.request_id, data, error: null });
      }

      const itemMatch = /^\/items\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'DELETE' && itemMatch?.[1]) {
        limiter.check(principal, 'ingest');
        if (url.searchParams.size > 0) throw new ApiError('BAD_REQUEST', 'Forget does not accept query parameters', 400);
        const data = store.forget({ principal, itemId: itemMatch[1], ...(requestId ? { requestId } : {}) });
        return send(res, 200, { ok: true, request_id: requestId, data, error: null });
      }
      if (req.method === 'GET' && itemMatch?.[1]) {
        const includes = url.searchParams.getAll('include');
        if (includes.length > 1 || (includes.length === 1 && includes[0] !== 'text')) {
          throw new ApiError('BAD_REQUEST', 'include must be a single value: text', 400);
        }
        const item = getItem(db, itemMatch[1], { includeText: includes[0] === 'text' });
        if (!item) throw new ApiError('NOT_FOUND', 'Item not found', 404);
        return send(res, 200, { ok: true, request_id: requestId, data: item, error: null });
      }

      if (req.method === 'GET' && url.pathname === '/activity') {
        const rows = db.prepare(`
          SELECT id, type, principal, request_id, item_id, metadata_json, created_at
          FROM activity_log ORDER BY created_at DESC LIMIT 50
        `).all();
        return send(res, 200, { ok: true, request_id: requestId, data: rows, error: null });
      }

      throw new ApiError('NOT_FOUND', 'Route not found', 404);
    } catch (error) {
      const normalized = normalizeError(error);
      outcome.error(normalized instanceof ApiError ? normalized.code : 'INTERNAL_ERROR');
      const status = normalized instanceof ApiError ? normalized.status : 500;
      return send(res, status, { ok: false, request_id: requestId, data: null, error: toErrorPayload(normalized) });
    }
  });
}

/** Optional semantic context and indexing share the request budget without consuming its save margin. */
export function createEmbeddingReadingAnalyzer(db: Database, baseAnalyzer: ReadingAnalyzer, embedder: Embedder | null): ReadingAnalyzer {
  return async (input) => {
    const priorItemIds = embedder ? await optionalEmbedding(input, async (signal) => {
      const vector = await embedder.embed([input.title ?? '', input.text].join('\n').slice(0, 16_000), signal);
      return vectorNeighbors(db, vector, embedder.model, { topK: 5, excludeItemId: input.itemId })
        .filter(hit => hit.distance <= 0.5).map(hit => hit.item_id);
    }) ?? [] : [];
    // Keep the original request signal on model work; optional timeouts only cancel their own calls.
    const analysis = await baseAnalyzer({ ...input, priorItemIds });
    const embedding = embedder ? await optionalEmbedding(input,
      (signal) => embedAnalysis(embedder, input.title, analysis, signal)) : null;
    return { ...analysis, embedding };
  };
}

async function optionalEmbedding<T>(input: ReadingAnalyzerInput, fn: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  const ms = Math.min(5000, (input.deadline ?? Infinity) - Date.now() - 250);
  if (ms <= 0 || input.signal?.aborted) return null;
  try {
    return await withTimeout((signal) => fn(input.signal ? AbortSignal.any([input.signal, signal]) : signal), ms);
  } catch {
    // Race the provider against the timeout even when it ignores cancellation; lexical analysis stays usable.
    return null;
  }
}

function assertAllowedHost(req: IncomingMessage, config: AppConfig) {
  const host = req.headers.host;
  if (!host) return;

  if (!isLoopbackHostHeader(host, config.host)) {
    throw new ApiError('BAD_REQUEST', 'Host header must target the loopback Reading API service', 400);
  }
}

function isLoopbackHostHeader(host: string, configuredHost: string) {
  const normalized = host.toLowerCase();
  if (normalized === '[::1]' || normalized.startsWith('[::1]:')) return true;

  const hostname = normalized.split(':')[0];
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === configuredHost.toLowerCase();
}

function normalizeError(error: unknown) {
  if (error instanceof ApiError) return error;
  if (error instanceof v.ValiError) {
    return new ApiError('BAD_REQUEST', error.message, 400);
  }
  return error;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > LIMITS.maxBodyBytes) {
      throw new ApiError('PAYLOAD_TOO_LARGE', 'Request body exceeds byte limit', 413);
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError('BAD_REQUEST', 'Request body must be valid JSON', 400);
  }
}

function send(res: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function setSecurityHeaders(res: ServerResponse) {
  res.setHeader('x-content-type-options', 'nosniff');
}

function capabilities() {
  return {
    supported_ingest_types: ['url', 'text', 'pdf_url'],
    query_modes: ['fts', 'fts+usage', 'hybrid'],
    lexical_policies: ['any', 'all'],
    supports_brief_events: true,
    brief_event_kinds: ['included', 'skipped', 'resurfaced', 'cited'],
    supports_reader_annotations: true,
    supports_forget: true,
    supports_reanalyze: true,
    supports_stale_items: true,
    analysis_version: READING_ANALYSIS_VERSION,
    query_confidence: 'uncalibrated; null for matches, zero for empty results',
    query_matching: 'meaningful terms across the full question; lexical_policy=any defaults to AND with partial-term OR fallback; all requires every extracted term. Coverage is not answer confidence.',
    brief_time_boundary: 'UTC end of brief_date, exclusive next midnight',
    max_sync_response_seconds: LIMITS.maxSyncResponseSeconds,
    idempotency_ttl_seconds: LIMITS.idempotencyTtlSeconds,
    max_text_chars: LIMITS.maxTextChars,
    max_url_bytes: LIMITS.maxUrlBytes,
    max_pdf_pages: LIMITS.maxPdfPages,
    max_pdf_bytes: LIMITS.maxPdfBytes,
    max_pdf_extracted_chars: PDF_PARSE_LIMITS.maxOutputChars,
    pdf_parse_timeout_seconds: PDF_PARSE_LIMITS.timeoutMs / 1000,
    rate_limits: { ingest_per_minute: 10, query_per_minute: 30, annotation_per_minute: 30 }
  };
}

function health(db: Database, config: AppConfig, analyzer: AnalyzerHealth) {
  db.prepare('SELECT 1').get();
  const fs = statfsSync(config.dataDir);
  const freeBytes = Number(fs.bavail) * Number(fs.bsize);
  const ready = freeBytes >= LIMITS.minDiskFreeBytes && analyzer.status === 'ok';
  return {
    status: ready ? 'ok' : 'danger',
    ready,
    db: 'ok',
    analyzer,
    analysis: analysisFreshness(db, READING_ANALYSIS_VERSION, config.flueModel),
    disk: { free_bytes: freeBytes, warn: freeBytes < LIMITS.warnDiskFreeBytes },
    backup: backupHealth(config)
  };
}

type BackupHealth = {
  status: 'ok' | 'stale' | 'missing' | 'unknown';
  warn: boolean;
  last_backup_at?: string;
  age_seconds?: number;
};

// Reports backup recency by inspecting `${READING_API_BACKUP_DIR}/reading-*.sqlite`.
// `missing` covers both no directory and an empty directory — the same surface
// for "you've never backed up here". `stale` fires if the newest backup is
// older than the daily-timer threshold + slop. `unknown` is reserved for
// filesystem errors so the health endpoint stays informative without falling
// over.
function backupHealth(config: AppConfig): BackupHealth {
  if (!existsSync(config.backupDir)) {
    return { status: 'missing', warn: false };
  }

  let entries: string[];
  try {
    entries = readdirSync(config.backupDir);
  } catch {
    return { status: 'unknown', warn: false };
  }

  const candidates = entries.filter((name) => name.startsWith('reading-') && name.endsWith('.sqlite'));
  if (candidates.length === 0) {
    return { status: 'missing', warn: false };
  }

  let newestMtime = 0;
  for (const name of candidates) {
    try {
      const mtime = statSync(join(config.backupDir, name)).mtimeMs;
      if (mtime > newestMtime) newestMtime = mtime;
    } catch {
      // Skip files we can't stat; keep scanning the rest.
    }
  }

  if (newestMtime === 0) {
    return { status: 'unknown', warn: false };
  }

  const ageSeconds = Math.max(0, Math.round((Date.now() - newestMtime) / 1000));
  const stale = ageSeconds > LIMITS.staleBackupSeconds;
  return {
    status: stale ? 'stale' : 'ok',
    warn: stale,
    last_backup_at: new Date(newestMtime).toISOString(),
    age_seconds: ageSeconds
  };
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) throw new ApiError('TIMEOUT', 'Operation exceeded synchronous response budget', 504, true, 60);
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new ApiError('TIMEOUT', 'Operation exceeded synchronous response budget', 504, true, 60));
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function remainingMs(deadline: number) {
  return Math.max(0, deadline - Date.now());
}
