interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    errors?: Array<{ reason?: string; message?: string }>;
    status?: string;
  };
}

const RETRYABLE_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'backendError',
  'internalError',
]);

function retryAfterMilliseconds(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export class DriveApiError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly reason?: string;

  constructor(
    message: string,
    readonly status: number,
    options: { retryable?: boolean; retryAfterMs?: number; reason?: string } = {},
  ) {
    super(message);
    this.name = 'DriveApiError';
    this.reason = options.reason;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable ?? (status === 429 || status >= 500);
  }

  static async fromResponse(response: Response): Promise<DriveApiError> {
    let body: GoogleErrorBody | undefined;
    try {
      body = (await response.clone().json()) as GoogleErrorBody;
    } catch {
      body = undefined;
    }
    const detail = body?.error?.errors?.[0];
    const reason = detail?.reason ?? body?.error?.status;
    const message =
      body?.error?.message ??
      detail?.message ??
      `Google Drive request failed (${response.status}).`;
    return new DriveApiError(message, response.status, {
      reason,
      retryAfterMs: retryAfterMilliseconds(response),
      retryable:
        response.status === 429 ||
        response.status >= 500 ||
        (reason ? RETRYABLE_REASONS.has(reason) : false),
    });
  }
}

export function driveFailure(error: unknown): {
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  blockReason?: string;
} {
  if (error instanceof DriveApiError) {
    return {
      message: error.message,
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
      blockReason:
        error.status === 401 || (error.status === 403 && !error.retryable)
          ? 'Google Drive authorization is required.'
          : undefined,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  return { message, retryable: offline || error instanceof TypeError };
}
