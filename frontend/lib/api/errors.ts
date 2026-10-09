/**
 * The contract's single error envelope (api-contract.md §0):
 *   { "error": { "code": "...", "message": "...", "details": { ... } } }
 * Every failed request surfaces as an ApiError so screens can branch on
 * `status`/`code` (e.g. 410 INVITE_NOT_ACTIVE, 409 SOLE_OWNER) rather than
 * string-matching messages.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  /** Seconds, from a 429's Retry-After header. */
  readonly retryAfter?: number;

  constructor(opts: {
    status: number;
    code: string;
    message: string;
    details?: Record<string, unknown>;
    retryAfter?: number;
  }) {
    super(opts.message);
    this.name = 'ApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details;
    this.retryAfter = opts.retryAfter;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/** "in 3 minutes", "in about an hour" — for a 429's Retry-After (seconds). */
export function formatWait(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return 'in a few minutes';
  const minutes = Math.ceil(seconds / 60);
  if (minutes <= 1) return 'in a minute';
  if (minutes < 55) return `in ${minutes} minutes`;
  if (minutes <= 75) return 'in about an hour';
  return `in about ${Math.round(minutes / 60)} hours`;
}

/**
 * Wording for the volume quotas (ADR-011), which aren't "failed attempts":
 * the person did nothing wrong, the organization or network just hit an
 * hourly cap. Returns undefined when `err` isn't a 429.
 */
export function quotaMessage(
  err: unknown,
  action: 'invite' | 'reissue' | 'signup' | 'reset',
): string | undefined {
  if (!isApiError(err) || err.status !== 429) return undefined;
  const when = formatWait(err.retryAfter);
  switch (action) {
    case 'invite':
      return `Your organization has sent the maximum number of invites for this hour. You can send more ${when}. Creating accounts directly isn’t limited.`;
    case 'reissue':
      return `This password has been reissued too many times in the last hour. Try again ${when}.`;
    case 'signup':
      return `Too many organizations have been created from your network recently. Try again ${when}.`;
    case 'reset':
      return `Too many reset requests. Check your inbox for an earlier link, or try again ${when}.`;
  }
}

/** Human-readable message for any thrown value — for toasts and form-level alerts. */
export function errorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (isApiError(err)) {
    if (err.status === 0) return 'Can’t reach the server. Check your connection and try again.';
    if (err.status === 429) {
      return `Too many attempts. Try again ${formatWait(err.retryAfter)}.`;
    }
    // 500s carry a deliberately generic server message already.
    return err.message || fallback;
  }
  return fallback;
}
