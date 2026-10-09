import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';

export interface ActiveSessionRow {
  id: string;
  deviceInfo: string | null;
  ipAddress: string | null;
  createdAt: Date;
  expiresAt: Date;
}

// planning/business-rules-and-defaults.md ("Authentication")
const REFRESH_TTL_DAYS = 30;

/**
 * tenant.sessions read/write, shared across every caller that issues,
 * rotates, revokes or lists refresh-token-backed sessions: Owner bootstrap
 * (organizations.service.ts) and login/refresh/logout/GET+DELETE
 * /me/sessions (auth.service.ts). Centralized here once a third caller
 * showed up — through Step 1.3 and the first Step 1.4 slice this was a
 * ~6-line private method duplicated per call site, flagged in both places
 * as "extract once a third caller needs it."
 */
@Injectable()
export class SessionsService {
  /**
   * Inserts a brand-new session row, returning both its id (embedded in the
   * access token as `sessionId` — see tokens.service.ts) and the raw
   * (unhashed) refresh token.
   */
  async issue(
    client: PoolClient,
    organizationId: string,
    userId: string,
    deviceInfo?: string,
    ipAddress?: string,
  ): Promise<{ sessionId: string; refreshToken: string }> {
    const rawToken = randomBytes(32).toString('hex');
    // Refresh tokens are high-entropy random strings, not passwords —
    // sha256 for a fast equality lookup is appropriate here; argon2id is
    // reserved for the one thing it's actually for (passwords).
    const tokenHash = this.hash(rawToken);

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO tenant.sessions (organization_id, user_id, refresh_token_hash, device_info, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))
       RETURNING id`,
      [organizationId, userId, tokenHash, deviceInfo ?? null, ipAddress ?? null, REFRESH_TTL_DAYS],
    );

    return { sessionId: rows[0].id, refreshToken: rawToken };
  }

  /**
   * Finds the (not-revoked, not-expired) session a raw refresh token
   * belongs to — with no tenant context, because the organization isn't
   * known until this lookup returns it (the same bootstrap problem
   * control.user_directory's by-email lookup solves for login). This is
   * safe without RLS scoping for the same reason: the lookup key is an
   * unguessable, unique, high-entropy value, so a match can only ever be
   * produced by whoever already holds that exact cookie — the query
   * can't be scoped to an org before it runs, but it also can't leak
   * anything to someone who doesn't already hold the secret.
   *
   * Uses queryBypassingRls(), not query() — see
   * migrations/008_app_bootstrap_role.sql. This used to be a plain
   * query(), which worked only by accident while the app connected as the
   * migration superuser; once migration 006 moved the app to the properly
   * RLS-scoped app_user role, this started failing outright (a 500, not
   * just an empty result — see that migration file for the exact
   * mechanism), since app_user has no org context to evaluate the RLS
   * policy against at this point in the flow.
   */
  async findActiveByRawToken(
    db: DatabaseService,
    rawToken: string,
  ): Promise<{ id: string; organizationId: string; userId: string } | undefined> {
    const tokenHash = this.hash(rawToken);
    const { rows } = await db.queryBypassingRls<{ id: string; organization_id: string; user_id: string }>(
      `SELECT id, organization_id, user_id FROM tenant.sessions
       WHERE refresh_token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [tokenHash],
    );
    if (rows.length === 0) {
      return undefined;
    }
    return { id: rows[0].id, organizationId: rows[0].organization_id, userId: rows[0].user_id };
  }

  /**
   * Rotation updates the SAME row with a new bearer secret and a new
   * sliding expiry, rather than revoking it and inserting a new one. A
   * long-lived tab silently refreshing every 15 minutes would otherwise
   * spam GET /me/sessions ("active sessions/devices",
   * architecture/api-contract.md §1) with one row per refresh instead of
   * one row per device/login — the whole point of that screen.
   */
  async rotate(client: PoolClient, sessionId: string): Promise<string> {
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = this.hash(rawToken);
    await client.query(
      `UPDATE tenant.sessions SET refresh_token_hash = $1, expires_at = now() + make_interval(days => $2)
       WHERE id = $3`,
      [tokenHash, REFRESH_TTL_DAYS, sessionId],
    );
    return rawToken;
  }

  /** Returns true iff a matching, not-already-revoked session owned by this user was found and revoked. */
  async revokeById(client: PoolClient, sessionId: string, userId: string): Promise<boolean> {
    const { rowCount } = await client.query(
      `UPDATE tenant.sessions SET revoked_at = now()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [sessionId, userId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** DELETE /me/sessions ("Revoke all sessions except the current one"). */
  async revokeAllExcept(client: PoolClient, userId: string, exceptSessionId?: string): Promise<void> {
    await client.query(
      `UPDATE tenant.sessions SET revoked_at = now()
       WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)`,
      [userId, exceptSessionId ?? null],
    );
  }

  async listActive(client: PoolClient, userId: string): Promise<ActiveSessionRow[]> {
    const { rows } = await client.query<{
      id: string;
      device_info: string | null;
      ip_address: string | null;
      created_at: Date;
      expires_at: Date;
    }>(
      `SELECT id, device_info, ip_address, created_at, expires_at
       FROM tenant.sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map((r) => ({
      id: r.id,
      deviceInfo: r.device_info,
      ipAddress: r.ip_address,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    }));
  }

  private hash(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }
}
