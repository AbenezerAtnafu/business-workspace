import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppException } from '../errors/app-exception';

export interface AccessTokenClaims {
  type: 'access';
  organizationId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member';
  // The tenant.sessions row this access token was issued alongside.
  // Discovered necessary during Step 1.4's session-lifecycle slice: the
  // refresh cookie is intentionally scoped to /api/v1/auth/refresh only
  // (architecture/api-contract.md §0), so it is NEVER present on
  // /me/sessions or /auth/logout requests — a real browser (and curl,
  // correctly emulating one) simply won't attach it outside that one
  // path. Carrying sessionId in the access token itself (sent via
  // Authorization header, not a path-scoped cookie) is what lets logout
  // and GET /me/sessions identify "the current session" without needing
  // the refresh cookie anywhere but POST /auth/refresh itself.
  sessionId: string;
}

/**
 * architecture/api-contract.md §0: "Every authenticated request carries the
 * caller's organizationId, userId, and role inside the access token's
 * claims; no endpoint takes an organization ID as a path or body parameter."
 *
 * `type: 'access'` is a discriminator, not currently load-bearing on its
 * own — it exists so that when Step 1.4's later sub-slices add
 * passwordChangeToken/mfaChallengeToken (short-lived, single-use, §1's
 * "Login flow, in full"), JwtAuthGuard can reject one of *those* tokens
 * presented as a normal Bearer access token, rather than relying on every
 * caller remembering to check scope by convention.
 */
@Injectable()
export class TokensService {
  constructor(private readonly jwtService: JwtService) {}

  signAccessToken(claims: Omit<AccessTokenClaims, 'type'>): string {
    return this.jwtService.sign({ type: 'access', ...claims });
  }

  /**
   * Verifies a Bearer token and asserts it's an access token (not some
   * future token `type`). Throws AppException(401, 'UNAUTHENTICATED', ...)
   * on any failure — expired, malformed, wrong signature, or wrong `type` —
   * so JwtAuthGuard can let this propagate straight to AllExceptionsFilter
   * without its own try/catch.
   */
  verifyAccessToken(token: string): AccessTokenClaims {
    let payload: AccessTokenClaims;
    try {
      payload = this.jwtService.verify<AccessTokenClaims>(token);
    } catch {
      throw new AppException(401, 'UNAUTHENTICATED', 'Invalid or expired access token.');
    }
    if (payload.type !== 'access') {
      throw new AppException(401, 'UNAUTHENTICATED', 'Invalid or expired access token.');
    }
    return payload;
  }
}
