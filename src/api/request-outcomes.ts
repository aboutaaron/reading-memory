import { performance } from 'node:perf_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ErrorCode } from './errors.js';

const ROUTES = ['/health', '/capabilities', '/diagnostics', '/ingest', '/query', '/brief-guide', '/brief-events', '/activity', '/items'] as const;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
const ERROR_CODES: readonly ErrorCode[] = ['BAD_REQUEST', 'UNAUTHORIZED', 'NOT_FOUND', 'ITEM_FORGOTTEN', 'RATE_LIMITED',
  'IDEMPOTENCY_CONFLICT', 'ANALYSIS_IN_PROGRESS', 'FETCH_FAILED', 'UNSUPPORTED_MIME', 'PAYLOAD_TOO_LARGE',
  'TIMEOUT', 'ANALYSIS_FAILED', 'INTERNAL_ERROR'];
export type RequestRoute = typeof ROUTES[number] | '/items/:itemId' | '/items/:itemId/annotations' | '/items/:itemId/reanalyze' | 'unmatched';
export type RequestOutcome = {
  event: 'reading-api.request';
  method: typeof METHODS[number] | 'OTHER';
  route: RequestRoute;
  status: number;
  error_code: ErrorCode | null;
  duration_ms: number;
};
export type RequestOutcomeLogger = (outcome: RequestOutcome) => void | Promise<void>;

export function requestRoute(pathname: string): RequestRoute {
  if ((ROUTES as readonly string[]).includes(pathname)) return pathname as typeof ROUTES[number];
  if (/^\/items\/[^/]+\/reanalyze$/.test(pathname)) return '/items/:itemId/reanalyze';
  if (/^\/items\/[^/]+\/annotations$/.test(pathname)) return '/items/:itemId/annotations';
  if (/^\/items\/[^/]+$/.test(pathname)) return '/items/:itemId';
  return 'unmatched';
}

/** Emits one allowlisted event after a completed response. Logging never changes request behavior. */
export function observeRequest(req: IncomingMessage, res: ServerResponse, logger: RequestOutcomeLogger | null) {
  let route: RequestRoute = 'unmatched';
  let errorCode: ErrorCode | null = null;
  const method = (METHODS as readonly string[]).includes(req.method ?? '') ? req.method as typeof METHODS[number] : 'OTHER';
  const started = performance.now();
  if (logger) res.once('finish', () => {
    const elapsed = Math.max(0, performance.now() - started);
    const outcome: RequestOutcome = {
      event: 'reading-api.request', method, route,
      status: Number.isInteger(res.statusCode) && res.statusCode >= 100 && res.statusCode <= 599 ? res.statusCode : 500,
      error_code: errorCode,
      duration_ms: Number.isFinite(elapsed) ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(elapsed)) : 0
    };
    try {
      // Async sinks may reject after this finish handler returns. Consume those
      // failures too, so telemetry cannot crash the service or print error text.
      void Promise.resolve(logger(outcome)).catch(() => {});
    } catch { /* Observability is best-effort; never echo a logger error. */ }
  });
  return {
    route(pathname: string) { route = requestRoute(pathname); },
    error(code: unknown) { errorCode = typeof code === 'string' && (ERROR_CODES as readonly string[]).includes(code)
      ? code as ErrorCode : 'INTERNAL_ERROR'; }
  };
}
