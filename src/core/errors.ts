/** Typed errors used throughout JARVIS. */

export type ErrorCode =
  | 'CONFIG'
  | 'AUTH'
  | 'POLICY_DENIED'
  | 'TOOL_ERROR'
  | 'LLM_ERROR'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'TIMEOUT'
  | 'RATE_LIMIT'
  | 'UNAVAILABLE'
  | 'INTERNAL';

export interface JarvisErrorOptions {
  status?: number;
  details?: unknown;
  retryable?: boolean;
  cause?: unknown;
}

export class JarvisError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: JarvisErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'JarvisError';
    this.code = code;
    this.status = options.status ?? statusForCode(code);
    this.details = options.details;
    this.retryable = options.retryable ?? (code === 'TIMEOUT' || code === 'RATE_LIMIT' || code === 'UNAVAILABLE');
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      status: this.status,
      retryable: this.retryable,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

function statusForCode(code: ErrorCode): number {
  switch (code) {
    case 'AUTH':
      return 401;
    case 'POLICY_DENIED':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'VALIDATION':
    case 'CONFIG':
      return 400;
    case 'RATE_LIMIT':
      return 429;
    case 'TIMEOUT':
      return 504;
    case 'UNAVAILABLE':
      return 503;
    case 'LLM_ERROR':
    case 'TOOL_ERROR':
    case 'INTERNAL':
    default:
      return 500;
  }
}

export function isJarvisError(error: unknown): error is JarvisError {
  return error instanceof JarvisError;
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  const code = (error as { code?: unknown }).code;
  return name === 'AbortError' || name === 'TimeoutError' || code === 'ABORT_ERR' || code === 'ETIMEDOUT';
}

/** A safe, human-readable message for any thrown value. Never contains stack traces. */
export function errorMessage(error: unknown): string {
  if (isJarvisError(error)) return error.message;
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Convert an HTTP-ish failure into a retryable JarvisError with context. */
export function httpError(service: string, status: number, body: string, retryAfterSeconds?: number): JarvisError {
  const snippet = body.replace(/\s+/g, ' ').slice(0, 500);
  const retryable = status === 408 || status === 429 || status >= 500;
  const code: ErrorCode = status === 401 || status === 403 ? 'AUTH' : status === 429 ? 'RATE_LIMIT' : retryable ? 'UNAVAILABLE' : 'INTERNAL';
  const suffix = retryAfterSeconds !== undefined ? ` (retry after ${retryAfterSeconds}s)` : '';
  return new JarvisError(code, `${service} request failed with HTTP ${status}${suffix}: ${snippet}`, {
    status,
    retryable,
    details: { service, upstreamStatus: status, retryAfterSeconds },
  });
}
