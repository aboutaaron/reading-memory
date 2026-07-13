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
import { BriefEventsRequestSchema, BriefGuideRequestSchema, IngestRequestSchema, QueryRequestSchema } from './contracts.js';
import { ItemStore } from '../reading/item-store.js';
import {
  createFlueReadingAnalyzer,
  flueAnalyzerHealth,
  type AnalyzerHealth,
  type ReadingAnalyzer
} from '../reading/flue-agent.js';
import { extractSource, payloadHash } from '../reading/extract-source.js';
import { briefGuide } from '../reading/brief-guide.js';
import { getItem, queryCorpus } from '../reading/corpus-query.js';
import { BriefEventStore, briefEventsPayloadHash } from '../reading/brief-events.js';

export function createReadingApi(
  config: AppConfig,
  db: Database,
  options: { analyzer?: ReadingAnalyzer; analyzerHealth?: () => AnalyzerHealth } = {}
) {
  const limiter = new RateLimiter({ ingest: 10, query: 30, brief: 10 });
  const store = new ItemStore(db);
  const briefEventStore = new BriefEventStore(db);
  const analyzer = options.analyzer ?? createFlueReadingAnalyzer(db, { model: config.flueModel, tracePath: config.flueTracePath });
  const analyzerHealth = options.analyzerHealth ?? (options.analyzer
    ? () => ({ status: 'ok' as const, warn: false })
    : flueAnalyzerHealth);

  return createServer(async (req, res) => {
    const requestId = req.headers['x-request-id']?.toString() ?? null;
    try {
      assertAllowedHost(req, config);
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      setSecurityHeaders(res);

      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true, request_id: requestId, data: health(db, config, analyzerHealth()), error: null });
      }

      const principal = requireAuth(req, config.authToken);

      if (req.method === 'GET' && url.pathname === '/capabilities') {
        return send(res, 200, { ok: true, request_id: requestId, data: capabilities(), error: null });
      }

      if (req.method === 'POST' && url.pathname === '/ingest') {
        limiter.check(principal, 'ingest');
        const deadline = Date.now() + LIMITS.maxSyncResponseSeconds * 1000;
        const raw = await readJson(req);
        const body = v.parse(IngestRequestSchema, normalizeSourceShape(raw));
        const source = await withTimeout((signal) => extractSource(body, signal), remainingMs(deadline));
        const response = await store.ingest({
          principal,
          requestId: body.request_id,
          payloadHash: payloadHash(body),
          source,
          analyze: (itemId) => withTimeout(
            () => analyzer({ itemId, title: source.title, text: source.extractedText, sessionId: `analysis:${itemId}:${body.request_id}` }),
            remainingMs(deadline)
          )
        });
        return send(res, 200, { ok: true, request_id: body.request_id, data: response, error: null });
      }

      if (req.method === 'POST' && url.pathname === '/query') {
        limiter.check(principal, 'query');
        const body = v.parse(QueryRequestSchema, await readJson(req));
        const queryInput: Parameters<typeof queryCorpus>[1] = { query: body.query };
        if (body.top_k !== undefined) queryInput.topK = body.top_k;
        if (body.filters?.since !== undefined) queryInput.since = body.filters.since;
        if (body.filters?.tags !== undefined) queryInput.tags = body.filters.tags;
        const data = queryCorpus(db, queryInput);
        return send(res, 200, { ok: true, request_id: body.request_id, data, error: null });
      }

      if (req.method === 'POST' && url.pathname === '/brief-guide') {
        limiter.check(principal, 'brief');
        const body = v.parse(BriefGuideRequestSchema, await readJson(req));
        const briefInput: Parameters<typeof briefGuide>[1] = { briefDate: body.brief_date };
        if (body.lookback_hours !== undefined) briefInput.lookbackHours = body.lookback_hours;
        if (body.focus !== undefined) briefInput.focus = body.focus;
        const data = briefGuide(db, briefInput);
        return send(res, 200, { ok: true, request_id: body.request_id, data, error: null });
      }

      if (req.method === 'POST' && url.pathname === '/brief-events') {
        limiter.check(principal, 'brief');
        const body = v.parse(BriefEventsRequestSchema, await readJson(req));
        const data = briefEventStore.record({
          principal,
          requestId: body.request_id,
          payloadHash: briefEventsPayloadHash(body),
          body
        });
        return send(res, 200, { ok: true, request_id: body.request_id, data, error: null });
      }

      const itemMatch = /^\/items\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && itemMatch?.[1]) {
        const item = getItem(db, itemMatch[1]);
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
      const status = normalized instanceof ApiError ? normalized.status : 500;
      const rid = requestIdFromError(error) ?? requestId;
      return send(res, status, { ok: false, request_id: rid, data: null, error: toErrorPayload(normalized) });
    }
  });
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

function normalizeSourceShape(raw: unknown) {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;
  const source = obj.source as Record<string, unknown> | undefined;
  if (!source || source.type) return raw;
  return { ...obj, source: { ...source, type: obj.source_type } };
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
    query_modes: ['fts'],
    supports_brief_events: true,
    max_sync_response_seconds: LIMITS.maxSyncResponseSeconds,
    idempotency_ttl_seconds: LIMITS.idempotencyTtlSeconds,
    max_text_chars: LIMITS.maxTextChars,
    max_url_bytes: LIMITS.maxUrlBytes,
    max_pdf_pages: LIMITS.maxPdfPages,
    rate_limits: { ingest_per_minute: 10, query_per_minute: 30 }
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

function requestIdFromError(error: unknown): string | null {
  if (error && typeof error === 'object' && 'issues' in error) return null;
  return null;
}
