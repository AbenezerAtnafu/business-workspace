import { HttpException } from '@nestjs/common';

/**
 * The one exception type application code should throw for any client-facing
 * error. architecture/api-contract.md §0's envelope — `{ error: { code,
 * message, details? } }` — is built from this at the HttpException level
 * (`status`), not left for AllExceptionsFilter to guess at from a generic
 * Error. `code` is a stable, documented string (e.g. `INVALID_CREDENTIALS`,
 * `VALIDATION_ERROR`) — the thing a frontend actually branches on, per the
 * contract's per-endpoint error tables; `message` is human-readable and may
 * change wording without being a breaking change.
 */
export class AppException extends HttpException {
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super({ code, message, details }, status);
    this.code = code;
    this.details = details;
  }
}
