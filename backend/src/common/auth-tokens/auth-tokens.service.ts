import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';

export type AuthTokenPurpose = 'password_reset' | 'mfa_challenge' | 'password_change';

/**
 * tenant.auth_tokens read/write — self-service password-reset links
 * (POST /auth/password-reset/request|confirm), MFA challenge tokens
 * (the mfaEnabled branch of POST /auth/login, consumed by POST
 * /auth/mfa/challenge), and — added in Step 1.6 — password-change tokens
 * (the mustChangePassword branch of POST /auth/login, consumed by POST
 * /auth/password-change: the forced first-login flow after a Path B
 * temp password or an admin-triggered reissue). Same shape, same
 * lifecycle, one shared table and service rather than three
 * near-duplicates — see the migration file's comment for why.
 *
 * Deliberately NOT built on TokensService's signed-JWT approach (unlike
 * AccessTokenClaims): both of these need to be single-use, and a JWT is
 * stateless by design — enforcing single-use on one would require a
 * persisted "consumed" record anyway, at which point the DB row itself is
 * the simpler source of truth. architecture/api-contract.md's
 * passwordChangeToken/mfaChallengeToken are described as JWT-like opaque
 * strings from the frontend's perspective either way; the mechanism behind
 * mfaChallengeToken's string is this table, not a signed token.
 */
@Injectable()
export class AuthTokensService {
  /** Inserts a new row, returning the raw (unhashed) token to hand to the caller. */
  async issue(
    client: PoolClient,
    organizationId: string,
    userId: string,
    purpose: AuthTokenPurpose,
    ttlMinutes: number,
  ): Promise<string> {
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = this.hash(rawToken);

    await client.query(
      `INSERT INTO tenant.auth_tokens (organization_id, user_id, purpose, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
      [organizationId, userId, purpose, tokenHash, ttlMinutes],
    );

    return rawToken;
  }

  /**
   * Finds a not-yet-used, not-yet-expired token of the given purpose, with
   * no tenant context required — the same bootstrap reasoning as
   * SessionsService.findActiveByRawToken: the organization isn't known
   * until this lookup returns it, and the lookup key being an unguessable,
   * unique, high-entropy value is what makes that safe.
   *
   * Uses queryBypassingRls(), not query() — see
   * migrations/008_app_bootstrap_role.sql and the matching comment on
   * SessionsService.findActiveByRawToken for why a plain query() here
   * breaks (a 500, not just an empty result) once the app connects as the
   * properly RLS-scoped app_user role.
   */
  async findValid(
    db: DatabaseService,
    rawToken: string,
    purpose: AuthTokenPurpose,
  ): Promise<{ id: string; organizationId: string; userId: string } | undefined> {
    const tokenHash = this.hash(rawToken);
    const { rows } = await db.queryBypassingRls<{ id: string; organization_id: string; user_id: string }>(
      `SELECT id, organization_id, user_id FROM tenant.auth_tokens
       WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()`,
      [tokenHash, purpose],
    );
    if (rows.length === 0) {
      return undefined;
    }
    return { id: rows[0].id, organizationId: rows[0].organization_id, userId: rows[0].user_id };
  }

  async consume(client: PoolClient, tokenId: string): Promise<void> {
    await client.query('UPDATE tenant.auth_tokens SET used_at = now() WHERE id = $1', [tokenId]);
  }

  private hash(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }
}
