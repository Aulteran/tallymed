export type ErrorCode =
  | 'invalid_input'
  | 'unauthenticated'
  | 'forbidden'
  | 'csrf_failed'
  | 'not_found'
  | 'stale_version'
  | 'conflict'
  | 'duplicate_warning'
  | 'bootstrap_closed'
  | 'rate_limited'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'duplicate_document'
  | 'storage_unavailable'
  | 'busy'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  invalid_input: 400,
  unauthenticated: 401,
  forbidden: 403,
  csrf_failed: 403,
  not_found: 404,
  stale_version: 409,
  conflict: 409,
  duplicate_warning: 409,
  bootstrap_closed: 409,
  rate_limited: 429,
  payload_too_large: 413,
  unsupported_media_type: 415,
  duplicate_document: 409,
  storage_unavailable: 503,
  busy: 429,
  internal: 500,
};

/** Stable, client-safe error. The message must never contain secrets or record content. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryAfterSeconds?: number;
  constructor(code: ErrorCode, message?: string, retryAfterSeconds?: number) {
    super(message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
