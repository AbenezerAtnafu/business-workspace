import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { AppException } from '../errors/app-exception';

/**
 * Normalizes every thrown error — AppException, Nest's own HttpExceptions
 * (including ValidationPipe's default BadRequestException shape), and truly
 * unexpected errors — into architecture/api-contract.md §0's one documented
 * envelope:
 *
 *   { "error": { "code": "...", "message": "...", "details": { ... } } }
 *
 * Confirmed live (Step 1.4 verification) that without this filter, Nest's
 * ValidationPipe returns `{"message": [...], "error": "Bad Request",
 * "statusCode": 400}` instead — a real, previously-undocumented gap between
 * the contract and the stock framework behavior, not just a style choice.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('AllExceptionsFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof AppException) {
      const { code, message, details } = exception;
      // api-contract.md §0: "A 429 response includes Retry-After."
      // RateLimitService puts the seconds in details.retryAfterSeconds.
      const retryAfter = details?.retryAfterSeconds;
      if (exception.getStatus() === 429 && typeof retryAfter === 'number') {
        response.setHeader('Retry-After', String(retryAfter));
      }
      response.status(exception.getStatus()).json({
        error: { code, message, ...(details !== undefined ? { details } : {}) },
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const { code, message, details } = this.normalize(status, exception.getResponse());
      response.status(status).json({
        error: { code, message, ...(details !== undefined ? { details } : {}) },
      });
      return;
    }

    // Truly unexpected — log the real error server-side, never leak its
    // internals (stack trace, driver error text) to the client.
    this.logger.error(exception instanceof Error ? exception.stack : exception);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Something went wrong. Please try again.' },
    });
  }

  /**
   * Maps a framework-thrown HttpException (most commonly ValidationPipe's
   * BadRequestException) onto { code, message, details }. `codeForStatus` is
   * deliberately coarse — a generic per-status code — because these are the
   * paths AppException didn't construct; anywhere the contract calls for a
   * specific code (VALIDATION_ERROR, FORBIDDEN_ROLE, ...), application code
   * throws AppException directly instead of relying on this fallback.
   */
  private normalize(
    status: number,
    raw: unknown,
  ): { code: string; message: string; details?: Record<string, unknown> } {
    const codeForStatus: Record<number, string> = {
      400: 'VALIDATION_ERROR',
      401: 'UNAUTHENTICATED',
      403: 'FORBIDDEN_ROLE',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      410: 'GONE',
      422: 'UNPROCESSABLE',
      413: 'PAYLOAD_TOO_LARGE', // multer's file-size limit (webmail attachments)
      429: 'RATE_LIMITED',
    };
    const code = codeForStatus[status] ?? 'ERROR';

    if (typeof raw === 'string') {
      return { code, message: raw };
    }

    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      // class-validator via Nest's ValidationPipe: { message: string[], error: 'Bad Request', statusCode }
      if (Array.isArray(obj.message)) {
        return { code, message: obj.message.join('; '), details: { fields: obj.message } };
      }
      if (typeof obj.message === 'string') {
        return { code, message: obj.message };
      }
    }

    return { code, message: 'Request failed.' };
  }
}
