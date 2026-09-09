import { ApiError, type ErrorCode } from '../api/errors.js';
import type { Database } from '../db/connection.js';

const ERROR_CODES = new Set<ErrorCode>([
  'BAD_REQUEST', 'UNAUTHORIZED', 'NOT_FOUND', 'ITEM_FORGOTTEN', 'RATE_LIMITED',
  'IDEMPOTENCY_CONFLICT', 'ANALYSIS_IN_PROGRESS', 'FETCH_FAILED', 'UNSUPPORTED_MIME',
  'PAYLOAD_TOO_LARGE', 'TIMEOUT', 'ANALYSIS_FAILED', 'INTERNAL_ERROR'
]);

/** Never persist a provider exception's message, name, or arbitrary code. */
export function safeFailureMetadata(error: unknown): { error_code: ErrorCode | null; retryable: boolean | null } {
  return error instanceof ApiError && ERROR_CODES.has(error.code)
    ? { error_code: error.code, retryable: typeof error.retryable === 'boolean' ? error.retryable : null }
    : { error_code: null, retryable: null };
}

function failureDetails(raw: string | null) {
  try {
    const value: unknown = JSON.parse(raw ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { code: null, retryable: null };
    const metadata = value as Record<string, unknown>;
    if (typeof metadata.error_code !== 'string' || !ERROR_CODES.has(metadata.error_code as ErrorCode)) {
      return { code: null, retryable: null };
    }
    return { code: metadata.error_code as ErrorCode, retryable: typeof metadata.retryable === 'boolean' ? metadata.retryable : null };
  } catch {
    return { code: null, retryable: null };
  }
}

/** One read statement provides a consistent count and page, including empty pages. */
export function listFailedCaptures(db: Database, options: { limit?: number; offset?: number } = {}) {
  const limit = options.limit ?? 25;
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new ApiError('BAD_REQUEST', 'Use a limit from 1 to 100 and a nonnegative safe integer offset', 400);
  }
  const rows = db.prepare(`SELECT totals.total, page.* FROM
    (SELECT count(*) AS total FROM items WHERE status = 'failed') AS totals
    LEFT JOIN (
      SELECT i.id AS item_id, i.source_type, i.source_uri, i.title, i.ingested_at,
        length(trim(i.extracted_text)) > 0 AS retained_text,
        a.id AS failure_id, a.created_at AS failure_at, a.request_id, a.metadata_json
      FROM items i LEFT JOIN activity_log a ON a.id = (
        SELECT id FROM activity_log WHERE item_id = i.id AND type = 'ingest.analysis_failed'
        ORDER BY id DESC LIMIT 1
      )
      WHERE i.status = 'failed' ORDER BY i.ingested_at ASC, i.id ASC LIMIT ? OFFSET ?
    ) AS page ON 1`).all(limit, offset) as Array<{
      total: number; item_id: string | null; source_type: 'text' | 'url' | 'pdf_url'; source_uri: string | null;
      title: string | null; ingested_at: string; retained_text: number;
      failure_id: number | null; failure_at: string | null; request_id: string | null; metadata_json: string | null;
    }>;
  const total = rows[0]?.total ?? 0;
  const items = rows.filter((row) => row.item_id !== null).map((row) => {
    const details = failureDetails(row.metadata_json);
    const retainedText = Boolean(row.retained_text);
    return {
      item_id: row.item_id!, source_type: row.source_type, source_uri: row.source_uri, title: row.title,
      ingested_at: row.ingested_at, retained_text: retainedText,
      failure_stage: row.failure_id === null ? 'unknown' as const : 'analysis' as const,
      retry_disposition: details.retryable === true ? 'retryable' as const
        : details.retryable === false ? 'not_retryable' as const : 'unknown' as const,
      recovery: details.retryable === false ? 'inspect_failure' as const
        : retainedText ? 'retry_original_ingest' as const : 'recapture_original_source' as const,
      latest_failure: row.failure_id === null ? null : {
        at: row.failure_at, request_id: row.request_id, code: details.code, retryable: details.retryable
      }
    };
  });
  return { items, total, limit, offset, next_offset: offset < total && items.length < total - offset ? offset + items.length : null };
}
