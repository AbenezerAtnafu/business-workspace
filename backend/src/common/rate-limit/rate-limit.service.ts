import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../errors/app-exception';

export interface RateLimitPolicy {
  /** Failed attempts allowed inside one window before locking. */
  maxFailures: number;
  /** Window length, and the base lockout length that doubles on each consecutive lockout. */
  windowSeconds: number;
  /** Ceiling for the doubled lockout. */
  maxLockoutSeconds: number;
}

/**
 * planning/business-rules-and-defaults.md: "10 attempts / 15 min per
 * account+IP, exponential backoff." Lockouts last 15 min, then 30, 60, …
 * capped at 24 h; a successful login clears everything for that key.
 */
export const LOGIN_POLICY: RateLimitPolicy = {
  maxFailures: 10,
  windowSeconds: 15 * 60,
  maxLockoutSeconds: 24 * 60 * 60,
};

/**
 * Volume quotas — count EVERY attempt, not just failures — for endpoints
 * whose abuse is the action itself succeeding: each invite sends a real
 * email (platform sender reputation), each reissue revokes the target's
 * sessions, each signup creates an organization. Fixed windows: once the
 * limit is reached, further calls get 429 until the window ends. ADR-011.
 */
export interface QuotaPolicy {
  limit: number;
  windowSeconds: number;
}

export type QuotaName =
  | 'signupsPerIpPerHour'
  | 'invitesPerOrgPerHour'
  | 'reissuesPerUserPerHour'
  | 'reissuesPerOrgPerHour'
  | 'resetRequestsPerEmailPerHour'
  | 'resetRequestsPerIpPerHour'
  | 'sendsPerMailboxPerHour';

/** Consecutive-lockout history is forgotten after a day of no failures. */
const LOCKOUT_MEMORY_SECONDS = 24 * 60 * 60;

interface RateLimitRow {
  failures: number;
  window_started_at: Date;
  lockouts: number;
  locked_until: Date | null;
  updated_at: Date;
}

/**
 * Failure-counting rate limiter backed by control.auth_rate_limits
 * (migration 012). Only FAILED attempts count, so a legitimate user is
 * never throttled by their own successful logins.
 *
 * Usage around a credential check:
 *
 *   const key = this.rateLimit.key('login', email, ip);
 *   await this.rateLimit.assertNotLocked(key);          // 429 + Retry-After if locked
 *   if (!ok) { await this.rateLimit.recordFailure(key, LOGIN_POLICY); throw … }
 *   await this.rateLimit.reset(key);                    // on success
 *
 * Unknown accounts are counted exactly like wrong passwords, so the limiter
 * itself never reveals whether an email exists.
 *
 * Scope: per account+IP, as specified. That stops one client hammering one
 * account; it does not stop a distributed attack across many IPs, or one IP
 * spraying many accounts — that's an edge/WAF concern, noted in
 * claude/build-progress.md. `ip` comes from Express `req.ip`, so a deployment
 * behind a proxy/load balancer must set TRUST_PROXY (main.ts → Express's
 * `trust proxy`), or every client shares the proxy's IP.
 */
@Injectable()
export class RateLimitService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
  ) {}

  /** A named quota from config (`rateLimit.*`, ADR-011): N per hour. */
  quota(name: QuotaName): QuotaPolicy {
    return { limit: this.config.getOrThrow<number>(`rateLimit.${name}`), windowSeconds: 60 * 60 };
  }

  key(scope: string, identifier: string, ip: string | undefined): string {
    return createHash('sha256')
      .update(`${scope}|${identifier.trim().toLowerCase()}|${ip ?? 'unknown'}`)
      .digest('hex');
  }

  async assertNotLocked(key: string): Promise<void> {
    const { rows } = await this.db.query<{ locked_until: Date | null }>(
      'SELECT locked_until FROM control.auth_rate_limits WHERE key = $1',
      [key],
    );
    const lockedUntil = rows[0]?.locked_until;
    if (lockedUntil && lockedUntil.getTime() > Date.now()) {
      throw this.tooMany(lockedUntil);
    }
  }

  /**
   * Counts one failure. If that reaches the policy's limit, locks the key and
   * throws the 429 right away — the attempt that trips the limit already
   * gets Retry-After, rather than its normal 401.
   */
  async recordFailure(key: string, policy: RateLimitPolicy): Promise<void> {
    const lockedUntil = await this.db.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO control.auth_rate_limits (key) VALUES ($1) ON CONFLICT (key) DO NOTHING`,
        [key],
      );
      const { rows } = await client.query<RateLimitRow>(
        `SELECT failures, window_started_at, lockouts, locked_until, updated_at
         FROM control.auth_rate_limits WHERE key = $1 FOR UPDATE`,
        [key],
      );
      const row = rows[0];
      const now = Date.now();

      let { failures, lockouts } = row;
      let windowStartedAt = row.window_started_at;

      if (now - row.updated_at.getTime() > LOCKOUT_MEMORY_SECONDS * 1000) {
        lockouts = 0;
      }
      if (now - windowStartedAt.getTime() > policy.windowSeconds * 1000) {
        failures = 0;
        windowStartedAt = new Date(now);
      }

      failures += 1;
      let newLockedUntil: Date | null = null;
      if (failures >= policy.maxFailures) {
        const seconds = Math.min(policy.windowSeconds * 2 ** lockouts, policy.maxLockoutSeconds);
        newLockedUntil = new Date(now + seconds * 1000);
        lockouts += 1;
        failures = 0;
        windowStartedAt = new Date(now);
      }

      await client.query(
        `UPDATE control.auth_rate_limits
         SET failures = $2, window_started_at = $3, lockouts = $4,
             locked_until = COALESCE($5, locked_until), updated_at = now()
         WHERE key = $1`,
        [key, failures, windowStartedAt, lockouts, newLockedUntil],
      );
      return newLockedUntil;
    });

    if (lockedUntil) {
      throw this.tooMany(lockedUntil);
    }
  }

  /**
   * Counts one attempt against a volume quota and throws 429 (with
   * Retry-After = time left in the window) once the quota is used up.
   * Atomic in one statement, so concurrent requests can't both slip under
   * the limit. Reuses control.auth_rate_limits: `failures` holds the
   * attempt count, `window_started_at` the fixed window's start. Keys are
   * namespaced by scope, so they never collide with failure-based keys.
   *
   * Call it BEFORE doing the work, so rejected attempts cost nothing else.
   */
  async consume(key: string, policy: QuotaPolicy): Promise<void> {
    const { rows } = await this.db.query<{ count: number; window_started_at: Date }>(
      `INSERT INTO control.auth_rate_limits AS r (key, failures, window_started_at, updated_at)
       VALUES ($1, 1, now(), now())
       ON CONFLICT (key) DO UPDATE SET
         failures = CASE WHEN r.window_started_at <= now() - make_interval(secs => $2)
                         THEN 1 ELSE r.failures + 1 END,
         window_started_at = CASE WHEN r.window_started_at <= now() - make_interval(secs => $2)
                                  THEN now() ELSE r.window_started_at END,
         updated_at = now()
       RETURNING failures AS count, window_started_at`,
      [key, policy.windowSeconds],
    );
    const { count, window_started_at } = rows[0];
    if (count > policy.limit) {
      const windowEnds = new Date(window_started_at.getTime() + policy.windowSeconds * 1000);
      throw this.tooMany(windowEnds, 'Too many requests. Try again later.');
    }
  }

  async reset(key: string): Promise<void> {
    await this.db.query('DELETE FROM control.auth_rate_limits WHERE key = $1', [key]);
  }

  private tooMany(lockedUntil: Date, message = 'Too many failed attempts. Try again later.'): AppException {
    const retryAfterSeconds = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 1000));
    // AllExceptionsFilter turns details.retryAfterSeconds into the Retry-After header.
    return new AppException(429, 'RATE_LIMITED', message, {
      retryAfterSeconds,
    });
  }
}
