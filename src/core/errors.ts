export const ERROR_CODES = {
  BROWSER_NOT_FOUND: false,
  BROWSER_PROFILE_IN_USE: false,
  BROWSER_CONNECT_FAILED: true,
  AUTHENTICATION_REQUIRED: false,
  HUMAN_VERIFICATION_REQUIRED: false,
  RATE_LIMITED: false,
  CIRCUIT_OPEN: false,
  SESSION_BUSY: true,
  SELECTOR_NOT_FOUND: false,
  GENERATION_FAILED: false,
  GENERATION_TIMEOUT: false,
  MODEL_NOT_AVAILABLE: false,
  JOB_NOT_FOUND: false,
  JOB_OWNER_LOST: false,
  ARTIFACT_PATH_DENIED: false,
  UNSUPPORTED_CAPABILITY: false,
  INVALID_INPUT: false,
  ABORTED: true,
  INTERNAL: false,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class AIWebError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AIWebError';
    this.code = code;
    this.retryable = ERROR_CODES[code];
    if (details) this.details = details;
  }

  toPayload(): ErrorPayload {
    const p: ErrorPayload = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.details) p.details = this.details;
    return p;
  }
}

/** Convert anything thrown into a safe payload (no stack trace). */
export function toErrorPayload(err: unknown): ErrorPayload {
  if (err instanceof AIWebError) return err.toPayload();
  if (err instanceof Error && err.name === 'AbortError') {
    return { code: 'ABORTED', message: 'Operation aborted.', retryable: true };
  }
  return { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err), retryable: false };
}
