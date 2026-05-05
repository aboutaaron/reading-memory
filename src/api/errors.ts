export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'ANALYSIS_IN_PROGRESS'
  | 'FETCH_FAILED'
  | 'UNSUPPORTED_MIME'
  | 'PAYLOAD_TOO_LARGE'
  | 'TIMEOUT'
  | 'ANALYSIS_FAILED'
  | 'INTERNAL_ERROR';

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status = 400,
    public retryable = false,
    public retryAfterSeconds?: number,
    public suggestedNext?: string
  ) {
    super(message);
  }
}

export function toErrorPayload(error: unknown) {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      retry_after_seconds: error.retryAfterSeconds ?? null,
      suggested_next: error.suggestedNext ?? null
    };
  }

  return {
    code: 'INTERNAL_ERROR',
    message: 'Unexpected server error',
    retryable: false,
    retry_after_seconds: null,
    suggested_next: null
  };
}
