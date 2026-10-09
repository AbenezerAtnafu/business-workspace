import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app-exception';
import { AccessTokenClaims, TokensService } from '../../common/tokens/tokens.service';
import { ActiveSessionRow, SessionsService } from '../../common/sessions/sessions.service';
import { AuthTokensService } from '../../common/auth-tokens/auth-tokens.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { MailerService } from '../../common/mailer/mailer.service';
import { MfaService } from '../../common/mfa/mfa.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { LoginDto } from './dto/login.dto';
import { PasswordResetRequestDto } from './dto/password-reset-request.dto';
import { PasswordResetConfirmDto } from './dto/password-reset-confirm.dto';
import { PasswordChangeDto } from './dto/password-change.dto';
import { MfaVerifySetupDto } from './dto/mfa-verify-setup.dto';
import { MfaDisableDto } from './dto/mfa-disable.dto';
import { MfaChallengeDto } from './dto/mfa-challenge.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangeOwnPasswordDto } from './dto/change-own-password.dto';
import { LOGIN_POLICY, RateLimitPolicy, RateLimitService } from '../../common/rate-limit/rate-limit.service';

// mfaChallengeToken: "short-lived (10 minutes), single-use" — spelled out
// exactly in architecture/api-contract.md §1, same as passwordChangeToken.
const MFA_CHALLENGE_TTL_MINUTES = 10;
const PASSWORD_CHANGE_TTL_MINUTES = 10;
// The password-reset link's lifetime isn't pinned to a number anywhere in
// the docs (unlike the two above) — 1 hour is a judgment call, matching the
// standard "forgot password" convention.
const PASSWORD_RESET_TTL_MINUTES = 60;

/**
 * A 6-digit TOTP has a million values; without a cap, a stolen password plus
 * a 10-minute challenge token is a brute-forceable second factor. Five wrong
 * codes per token+IP locks that challenge for its remaining lifetime.
 */
const MFA_CHALLENGE_POLICY: RateLimitPolicy = {
  maxFailures: 5,
  windowSeconds: MFA_CHALLENGE_TTL_MINUTES * 60,
  maxLockoutSeconds: 24 * 60 * 60,
};

/** The columns every "current user" response (GET /me, login, mfa challenge, password reset confirm) needs. */
interface UserProfileRow {
  id: string;
  organization_id: string;
  org_unit_id: string;
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
}

interface UserAuthRow extends UserProfileRow {
  password_hash: string;
  status: string;
  must_change_password: boolean;
  mfa_enabled: boolean;
}

export interface LoginResult {
  accessToken: string;
  // Never put this in a JSON response body — the controller sets it as the
  // httpOnly refresh cookie per architecture/api-contract.md §0.
  refreshToken: string;
  user: {
    id: string;
    organizationId: string;
    orgUnitId: string;
    email: string;
    name: string;
    role: 'owner' | 'admin' | 'member';
  };
}

/** POST /auth/login's mfaEnabled branch — no session issued yet, just a challenge token. */
export interface MfaRequiredResult {
  mfaChallengeToken: string;
}

/** POST /auth/login's mustChangePassword branch — no session issued yet, just a change token. */
export interface PasswordChangeRequiredResult {
  passwordChangeToken: string;
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
}

export interface MeResult {
  id: string;
  organizationId: string;
  orgUnitId: string;
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
  mfaEnabled: boolean;
  /**
   * Null until the account has a company mailbox as its login identity — in
   * MVP only the Owner right after signup (api-contract.md §2). The Setup
   * Checklist uses it to decide whether "Claim your mailbox" is still open.
   * Added 2026-10-07.
   */
  primaryMailboxId: string | null;
}

export interface SessionListItem extends ActiveSessionRow {
  current: boolean;
}

export interface MfaSetupResult {
  secret: string;
  otpauthUrl: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tokens: TokensService,
    private readonly sessions: SessionsService,
    private readonly authTokens: AuthTokensService,
    private readonly encryption: EncryptionService,
    private readonly mailer: MailerService,
    private readonly mfa: MfaService,
    private readonly configService: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly auditLogs: AuditLogsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /**
   * POST /auth/login — architecture/api-contract.md §1 ("Login flow, in
   * full"). Both the mustChangePassword and mfaEnabled branches issue a
   * short-lived, single-use token instead of a session — mustChangePassword
   * now that Step 1.6's Users module can actually produce accounts in that
   * state (Path B, and admin-triggered reissue).
   */
  async login(
    dto: LoginDto,
    deviceInfo?: string,
    ipAddress?: string,
  ): Promise<LoginResult | MfaRequiredResult | PasswordChangeRequiredResult> {
    // planning/business-rules-and-defaults.md: 10 failed attempts / 15 min
    // per account+IP, exponential backoff (RateLimitService). Unknown emails
    // count exactly like wrong passwords so the limiter can't be used to
    // probe which accounts exist.
    const rateLimitKey = this.rateLimit.key('login', dto.email, ipAddress);
    await this.rateLimit.assertNotLocked(rateLimitKey);
    const fail = async (): Promise<never> => {
      await this.rateLimit.recordFailure(rateLimitKey, LOGIN_POLICY);
      throw new AppException(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.');
    };

    // No tenant context exists yet at login time — this call is what
    // establishes one. control.user_directory (email CITEXT PRIMARY KEY) is
    // the one cross-org-by-design lookup, matching "one email = one org in
    // MVP" (architecture/api-contract.md §0) — RLS is never bypassed here,
    // because this table has no tenant.* row and no RLS policy at all.
    const directory = await this.db.query<{ organization_id: string; user_id: string }>(
      'SELECT organization_id, user_id FROM control.user_directory WHERE email = $1',
      [dto.email],
    );
    if (directory.rows.length === 0) {
      // Same message/code whether the email doesn't exist or the password
      // is wrong — never reveal which one failed.
      return fail();
    }
    const { organization_id: organizationId, user_id: userId } = directory.rows[0];

    const user = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const { rows } = await client.query<UserAuthRow>(
        `SELECT id, organization_id, org_unit_id, email, name, password_hash, role, status,
                must_change_password, mfa_enabled
         FROM tenant.users WHERE id = $1`,
        [userId],
      );
      return rows[0];
    });

    if (!user || user.status !== 'active') {
      return fail();
    }

    const passwordOk = await argon2.verify(user.password_hash, dto.password);
    if (!passwordOk) {
      return fail();
    }

    // Correct password: clear the failure count whichever branch follows.
    await this.rateLimit.reset(rateLimitKey);

    if (user.must_change_password) {
      const passwordChangeToken = await this.db.withTransaction(async (client) => {
        await this.db.setTenantContext(client, organizationId);
        return this.authTokens.issue(client, organizationId, userId, 'password_change', PASSWORD_CHANGE_TTL_MINUTES);
      });
      return { passwordChangeToken };
    }

    if (user.mfa_enabled) {
      const mfaChallengeToken = await this.db.withTransaction(async (client) => {
        await this.db.setTenantContext(client, organizationId);
        return this.authTokens.issue(client, organizationId, userId, 'mfa_challenge', MFA_CHALLENGE_TTL_MINUTES);
      });
      return { mfaChallengeToken };
    }

    const { sessionId, refreshToken } = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      await client.query('UPDATE tenant.users SET last_login_at = now() WHERE id = $1', [userId]);
      const issued = await this.sessions.issue(client, organizationId, userId, deviceInfo, ipAddress);

      // Step 3.2: claude/srs.md §7.10 MVP event "Login." This is the
      // ordinary, no-MFA branch — mfaChallenge() below logs the equivalent
      // event for a login that required a second factor; the two are
      // mutually exclusive for any one login attempt (this method returns
      // early, with no session issued, whenever MFA is required), so
      // there's no double-logging between them.
      await this.auditLogs.record(client, organizationId, userId, 'user.login', { ipAddress });

      return issued;
    });

    const accessToken = this.tokens.signAccessToken({
      organizationId,
      userId,
      role: user.role,
      sessionId,
    });

    return {
      accessToken,
      refreshToken,
      user: this.toProfile(user),
    };
  }

  /**
   * POST /auth/mfa/challenge — the follow-up to login's mfaEnabled branch.
   * A wrong code does NOT consume the challenge token — the 10-minute
   * window is meant to allow a mistyped-code retry, not a one-shot guess;
   * "single-use" (api-contract.md §1) means it can't be reused to start a
   * SECOND session after a successful challenge, which consuming only on
   * success already guarantees.
   */
  async mfaChallenge(dto: MfaChallengeDto, deviceInfo?: string, ipAddress?: string): Promise<LoginResult> {
    const rateLimitKey = this.rateLimit.key('mfa-challenge', dto.mfaChallengeToken, ipAddress);
    await this.rateLimit.assertNotLocked(rateLimitKey);
    try {
      return await this.completeMfaChallenge(dto, deviceInfo, ipAddress);
    } catch (err) {
      if (err instanceof AppException && err.code === 'INVALID_CODE') {
        await this.rateLimit.recordFailure(rateLimitKey, MFA_CHALLENGE_POLICY);
      }
      throw err;
    }
  }

  private async completeMfaChallenge(dto: MfaChallengeDto, deviceInfo?: string, ipAddress?: string): Promise<LoginResult> {
    const found = await this.authTokens.findValid(this.db, dto.mfaChallengeToken, 'mfa_challenge');
    if (!found) {
      throw new AppException(401, 'UNAUTHENTICATED', 'This code has expired — please log in again.');
    }
    const { id: tokenId, organizationId, userId } = found;

    const result = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const { rows } = await client.query<UserAuthRow & { mfa_secret: string | null }>(
        `SELECT id, organization_id, org_unit_id, email, name, password_hash, role, status,
                must_change_password, mfa_enabled, mfa_secret
         FROM tenant.users WHERE id = $1`,
        [userId],
      );
      const user = rows[0];
      if (!user || user.status !== 'active' || !user.mfa_secret) {
        throw new AppException(401, 'UNAUTHENTICATED', 'This code has expired — please log in again.');
      }

      const codeOk = await this.mfa.verifyCode(this.encryption.decrypt(user.mfa_secret), dto.code);
      if (!codeOk) {
        throw new AppException(400, 'INVALID_CODE', 'The verification code is incorrect or expired.');
      }

      await this.authTokens.consume(client, tokenId);
      await client.query('UPDATE tenant.users SET last_login_at = now() WHERE id = $1', [userId]);
      const { sessionId, refreshToken } = await this.sessions.issue(client, organizationId, userId, deviceInfo, ipAddress);

      // Step 3.2: the "Login" event's MFA-required counterpart to login()'s
      // own record() call — see that call site's doc comment.
      await this.auditLogs.record(client, organizationId, userId, 'user.login', { ipAddress });

      return { user, sessionId, refreshToken };
    });

    const accessToken = this.tokens.signAccessToken({
      organizationId,
      userId,
      role: result.user.role,
      sessionId: result.sessionId,
    });

    return { accessToken, refreshToken: result.refreshToken, user: this.toProfile(result.user) };
  }

  /**
   * POST /auth/password-reset/request — "Always shows a generic check-your-
   * email message, whether or not the address exists" (screen-flow-
   * inventory.md §2.1). This method returns void either way; the controller
   * always answers 200 with the same generic body regardless of what
   * happened here.
   */
  async requestPasswordReset(dto: PasswordResetRequestDto, ipAddress?: string): Promise<void> {
    // ADR-011: public and sends email. Limited per email+IP (stops mail-
    // bombing one inbox) and per IP (stops spraying many). Applied before
    // the lookup and identically for unknown addresses, so a 429 says
    // nothing about whether the account exists.
    await this.rateLimit.consume(
      this.rateLimit.key('reset-request', dto.email, ipAddress),
      this.rateLimit.quota('resetRequestsPerEmailPerHour'),
    );
    await this.rateLimit.consume(
      this.rateLimit.key('reset-request-ip', '-', ipAddress),
      this.rateLimit.quota('resetRequestsPerIpPerHour'),
    );
    const directory = await this.db.query<{ organization_id: string; user_id: string }>(
      'SELECT organization_id, user_id FROM control.user_directory WHERE email = $1',
      [dto.email],
    );
    if (directory.rows.length === 0) {
      return;
    }
    const { organization_id: organizationId, user_id: userId } = directory.rows[0];

    const sendable = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const { rows } = await client.query<{ email: string; name: string; status: string }>(
        'SELECT email, name, status FROM tenant.users WHERE id = $1',
        [userId],
      );
      const user = rows[0];
      if (!user || user.status !== 'active') {
        // Suspended/deleted account — still a silent no-op externally.
        return undefined;
      }
      const rawToken = await this.authTokens.issue(
        client,
        organizationId,
        userId,
        'password_reset',
        PASSWORD_RESET_TTL_MINUTES,
      );
      return { rawToken, email: user.email, name: user.name };
    });

    if (!sendable) {
      return;
    }

    const resetUrl = `${this.configService.get<string>('appBaseUrl')}/reset-password?token=${sendable.rawToken}`;
    await this.mailer.send({
      to: sendable.email,
      subject: 'Reset your password',
      text:
        `Hi ${sendable.name},\n\n` +
        `Someone requested a password reset for your account. If this was you, use the ` +
        `link below within the next hour:\n\n${resetUrl}\n\n` +
        `If you didn't request this, you can safely ignore this email — your password hasn't changed.`,
    });
  }

  /**
   * POST /auth/password-reset/confirm. Revokes every existing session on
   * success (standard practice: if the old password was ever compromised,
   * this closes every door it or a stolen session cookie was propping
   * open) and issues exactly one fresh session for the device completing
   * the reset — matching Flow 6's "App Shell ← normal session."
   */
  async confirmPasswordReset(
    dto: PasswordResetConfirmDto,
    deviceInfo?: string,
    ipAddress?: string,
  ): Promise<LoginResult> {
    const found = await this.authTokens.findValid(this.db, dto.token, 'password_reset');
    if (!found) {
      throw new AppException(410, 'GONE', 'This reset link is invalid or has expired.');
    }
    const { id: tokenId, organizationId, userId } = found;
    const passwordHash = await argon2.hash(dto.newPassword, { type: argon2.argon2id });

    const result = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      await client.query(
        'UPDATE tenant.users SET password_hash = $1, must_change_password = false WHERE id = $2',
        [passwordHash, userId],
      );
      await this.authTokens.consume(client, tokenId);
      // No "current session" to except — the caller wasn't logged in.
      await this.sessions.revokeAllExcept(client, userId);
      // Step 3.1: "security alert" / "password reset" per SRS §7.9's example
      // list — notify the account itself, never with the new password.
      await this.notifications.create(client, organizationId, userId, 'password_reset');

      // Step 3.2: planning/business-rules-and-defaults.md's "Audit logs"
      // section explicitly names "password resets" as a required audit
      // event, with the same never-the-plaintext rule.
      await this.auditLogs.record(client, organizationId, userId, 'user.password_reset', {
        resourceType: 'user',
        resourceId: userId,
        ipAddress,
      });

      const { rows } = await client.query<UserProfileRow>(
        `SELECT id, organization_id, org_unit_id, email, name, role FROM tenant.users WHERE id = $1`,
        [userId],
      );
      const user = rows[0];
      await client.query('UPDATE tenant.users SET last_login_at = now() WHERE id = $1', [userId]);
      const { sessionId, refreshToken } = await this.sessions.issue(client, organizationId, userId, deviceInfo, ipAddress);
      return { user, sessionId, refreshToken };
    });

    const accessToken = this.tokens.signAccessToken({
      organizationId,
      userId,
      role: result.user.role,
      sessionId: result.sessionId,
    });

    return { accessToken, refreshToken: result.refreshToken, user: this.toProfile(result.user) };
  }

  /**
   * POST /auth/password-change — the mustChangePassword branch's follow-up
   * (architecture/api-contract.md §1). Reached after a Path B admin-issued
   * temp password, or after an admin-triggered reissue (planning/
   * business-rules-and-defaults.md — both set must_change_password = true
   * the same way). Revokes every existing session on success, same
   * reasoning as confirmPasswordReset: a reissue can target an account
   * that still has active sessions (e.g. "cut access immediately" —
   * business-rules-and-defaults.md's third reissue scenario), and this is
   * exactly the moment that access should actually be cut.
   */
  async passwordChange(
    dto: PasswordChangeDto,
    deviceInfo?: string,
    ipAddress?: string,
  ): Promise<LoginResult> {
    const found = await this.authTokens.findValid(this.db, dto.passwordChangeToken, 'password_change');
    if (!found) {
      throw new AppException(401, 'UNAUTHENTICATED', 'This link has expired — please log in again.');
    }
    const { id: tokenId, organizationId, userId } = found;
    const passwordHash = await argon2.hash(dto.newPassword, { type: argon2.argon2id });

    const result = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      await client.query(
        'UPDATE tenant.users SET password_hash = $1, must_change_password = false WHERE id = $2',
        [passwordHash, userId],
      );
      await this.authTokens.consume(client, tokenId);
      await this.sessions.revokeAllExcept(client, userId);
      await client.query('UPDATE tenant.users SET last_login_at = now() WHERE id = $1', [userId]);

      const { rows } = await client.query<UserProfileRow>(
        `SELECT id, organization_id, org_unit_id, email, name, role FROM tenant.users WHERE id = $1`,
        [userId],
      );
      const user = rows[0];
      const { sessionId, refreshToken } = await this.sessions.issue(client, organizationId, userId, deviceInfo, ipAddress);
      return { user, sessionId, refreshToken };
    });

    const accessToken = this.tokens.signAccessToken({
      organizationId,
      userId,
      role: result.user.role,
      sessionId: result.sessionId,
    });

    return { accessToken, refreshToken: result.refreshToken, user: this.toProfile(result.user) };
  }

  /**
   * POST /auth/refresh — architecture/api-contract.md §1 ("Rotates the
   * refresh token, issues a new access token"). Takes the raw cookie value,
   * not a Bearer token (the access token may already be expired — that's
   * the whole point of this endpoint) and is @Public() at the controller.
   *
   * Finding the session has to happen before any tenant context exists
   * (see SessionsService.findActiveByRawToken) — organizationId comes FROM
   * that lookup, not the other way around.
   */
  async refresh(rawRefreshToken: string | undefined): Promise<RefreshResult> {
    if (!rawRefreshToken) {
      throw new AppException(401, 'UNAUTHENTICATED', 'Missing refresh token.');
    }

    const found = await this.sessions.findActiveByRawToken(this.db, rawRefreshToken);
    if (!found) {
      throw new AppException(401, 'UNAUTHENTICATED', 'Invalid or expired refresh token.');
    }
    const { id: sessionId, organizationId, userId } = found;

    const { role, refreshToken } = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const { rows } = await client.query<{ role: 'owner' | 'admin' | 'member'; status: string }>(
        'SELECT role, status FROM tenant.users WHERE id = $1',
        [userId],
      );
      const user = rows[0];
      if (!user || user.status !== 'active') {
        throw new AppException(401, 'UNAUTHENTICATED', 'Account no longer active.');
      }
      const newRawToken = await this.sessions.rotate(client, sessionId);
      return { role: user.role, refreshToken: newRawToken };
    });

    const accessToken = this.tokens.signAccessToken({ organizationId, userId, role, sessionId });

    return { accessToken, refreshToken };
  }

  /**
   * POST /auth/logout — revokes the session named in the caller's own
   * access token claims (claims.sessionId), not anything read off the
   * refresh cookie: that cookie is scoped to /api/v1/auth/refresh only
   * (architecture/api-contract.md §0) and is never present on this
   * request. See the comment on AccessTokenClaims.sessionId.
   */
  async logout(claims: AccessTokenClaims): Promise<void> {
    await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, claims.organizationId);
      await this.sessions.revokeById(client, claims.sessionId, claims.userId);

      // Step 3.2: claude/srs.md §7.10 MVP event "Logout."
      await this.auditLogs.record(client, claims.organizationId, claims.userId, 'user.logout');
    });
  }

  /** GET /me — architecture/api-contract.md §1 ("Current user, org, role, org unit"). */
  async getMe(claims: AccessTokenClaims): Promise<MeResult> {
    const user = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, claims.organizationId);
      const { rows } = await client.query<UserProfileRow & { mfa_enabled: boolean; primary_mailbox_id: string | null }>(
        `SELECT id, organization_id, org_unit_id, email, name, role, mfa_enabled, primary_mailbox_id
         FROM tenant.users WHERE id = $1`,
        [claims.userId],
      );
      return rows[0];
    });

    if (!user) {
      // The access token was valid, but its user no longer exists (deleted
      // since the token was issued) — still an authentication failure, not
      // a 404, since the caller has no other identity to retry with.
      throw new AppException(401, 'UNAUTHENTICATED', 'User no longer exists.');
    }

    return { ...this.toProfile(user), mfaEnabled: user.mfa_enabled, primaryMailboxId: user.primary_mailbox_id };
  }

  /**
   * GET /me/sessions ("List active sessions/devices"). `current` compares
   * against claims.sessionId (from the caller's own access token) — not
   * the refresh cookie, which is scoped to /api/v1/auth/refresh only and
   * never arrives on this request. See AccessTokenClaims.sessionId.
   */
  async listSessions(claims: AccessTokenClaims): Promise<SessionListItem[]> {
    const activeSessions = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, claims.organizationId);
      return this.sessions.listActive(client, claims.userId);
    });

    return activeSessions.map((session) => ({ ...session, current: session.id === claims.sessionId }));
  }

  /** DELETE /me/sessions/{sessionId} — revoke one of the caller's own sessions. */
  async revokeSession(claims: AccessTokenClaims, sessionId: string): Promise<void> {
    const revoked = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, claims.organizationId);
      return this.sessions.revokeById(client, sessionId, claims.userId);
    });

    if (!revoked) {
      // Doesn't exist, already revoked, or belongs to someone else — same
      // 404 either way, the same "never reveal what exists outside the
      // caller's own scope" rule api-contract.md §0 states for cross-org
      // resources, extended here to cross-user ones.
      throw new AppException(404, 'NOT_FOUND', 'Session not found.');
    }
  }

  /**
   * DELETE /me/sessions — "Revoke all sessions except the current one."
   * `claims.sessionId` identifies "current," same reasoning as logout/
   * listSessions above.
   */
  async revokeAllSessions(claims: AccessTokenClaims): Promise<void> {
    await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, claims.organizationId);
      await this.sessions.revokeAllExcept(client, claims.userId, claims.sessionId);
    });
  }

  /**
   * POST /me/mfa/setup — generates a new TOTP secret and stores it
   * (encrypted) immediately, before enrollment is confirmed. `mfa_enabled`
   * stays false until POST /me/mfa/verify-setup succeeds, so a pending,
   * never-confirmed secret sitting in the column is harmless — it simply
   * never takes effect. Calling this again before verifying just
   * overwrites it with a fresh one (e.g. the user re-scans a new QR code).
   */
  async setupMfa(claims: AccessTokenClaims): Promise<MfaSetupResult> {
    const secret = this.mfa.generateSecret();
    const encryptedSecret = this.encryption.encrypt(secret);

    const email = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, claims.organizationId);
      const { rows } = await client.query<{ email: string }>('SELECT email FROM tenant.users WHERE id = $1', [
        claims.userId,
      ]);
      const user = rows[0];
      if (!user) {
        throw new AppException(401, 'UNAUTHENTICATED', 'User no longer exists.');
      }
      await client.query('UPDATE tenant.users SET mfa_secret = $1 WHERE id = $2', [encryptedSecret, claims.userId]);
      return user.email;
    });

    return { secret, otpauthUrl: this.mfa.buildOtpauthUri(email, secret) };
  }

  /** POST /me/mfa/verify-setup — confirms enrollment, flips mfa_enabled. */
  async verifyMfaSetup(claims: AccessTokenClaims, dto: MfaVerifySetupDto): Promise<void> {
    await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, claims.organizationId);
      const { rows } = await client.query<{ mfa_secret: string | null }>(
        'SELECT mfa_secret FROM tenant.users WHERE id = $1',
        [claims.userId],
      );
      const user = rows[0];
      if (!user || !user.mfa_secret) {
        throw new AppException(422, 'MFA_NOT_STARTED', 'Start MFA setup before verifying a code.');
      }

      const codeOk = await this.mfa.verifyCode(this.encryption.decrypt(user.mfa_secret), dto.code);
      if (!codeOk) {
        throw new AppException(400, 'INVALID_CODE', 'The verification code is incorrect or expired.');
      }

      await client.query('UPDATE tenant.users SET mfa_enabled = true WHERE id = $1', [claims.userId]);
    });
  }

  /**
   * POST /me/mfa/disable — "requires current password or a valid code,
   * never a bare toggle" (screen-flow-inventory.md §2.11). Clears
   * mfa_secret entirely on success, not just mfa_enabled, so a disable is a
   * clean teardown — re-enabling means enrolling a brand-new secret, not
   * resurrecting the old one.
   */
  async disableMfa(claims: AccessTokenClaims, dto: MfaDisableDto): Promise<void> {
    if (!dto.password && !dto.code) {
      throw new AppException(400, 'VALIDATION_ERROR', 'Provide your current password or a valid MFA code.');
    }

    await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, claims.organizationId);
      const { rows } = await client.query<{ password_hash: string; mfa_secret: string | null }>(
        'SELECT password_hash, mfa_secret FROM tenant.users WHERE id = $1',
        [claims.userId],
      );
      const user = rows[0];
      if (!user) {
        throw new AppException(401, 'UNAUTHENTICATED', 'User no longer exists.');
      }

      if (dto.password) {
        const ok = await argon2.verify(user.password_hash, dto.password);
        if (!ok) {
          throw new AppException(401, 'INVALID_CREDENTIALS', 'Incorrect password.');
        }
      } else {
        if (!user.mfa_secret) {
          throw new AppException(422, 'MFA_NOT_STARTED', 'MFA is not enabled on this account.');
        }
        const ok = await this.mfa.verifyCode(this.encryption.decrypt(user.mfa_secret), dto.code!);
        if (!ok) {
          throw new AppException(400, 'INVALID_CODE', 'The verification code is incorrect or expired.');
        }
      }

      await client.query('UPDATE tenant.users SET mfa_enabled = false, mfa_secret = NULL WHERE id = $1', [
        claims.userId,
      ]);
      // Step 3.1: "security alert" — worth surfacing even though the user
      // just did this themselves, same reasoning real-world "your password
      // was changed" emails use: a record to notice if it wasn't actually them.
      await this.notifications.create(client, claims.organizationId, claims.userId, 'mfa_disabled');
    });
  }

  /**
   * PATCH /me — screen-flow-inventory.md §2.11: "name only — email is
   * derived, not directly editable." Added 2026-10-07 (listed in
   * api-contract.md but never built). Not audited: claude/srs.md §7.10's
   * MVP event list has no profile-edit event.
   */
  async updateProfile(claims: AccessTokenClaims, dto: UpdateProfileDto): Promise<MeResult> {
    const user = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, claims.organizationId);
      const { rows } = await client.query<UserProfileRow & { mfa_enabled: boolean; primary_mailbox_id: string | null }>(
        `UPDATE tenant.users SET name = $1, updated_at = now() WHERE id = $2
         RETURNING id, organization_id, org_unit_id, email, name, role, mfa_enabled, primary_mailbox_id`,
        [dto.name, claims.userId],
      );
      return rows[0];
    });
    if (!user) {
      throw new AppException(401, 'UNAUTHENTICATED', 'User no longer exists.');
    }
    return { ...this.toProfile(user), mfaEnabled: user.mfa_enabled, primaryMailboxId: user.primary_mailbox_id };
  }

  /**
   * PATCH /me/password — api-contract.md §1: "Change own password (already
   * authenticated, not forced)"; screen-flow-inventory.md §2.11: "Requires
   * current password even though the user is already authenticated."
   * Added 2026-10-07.
   *
   * - Wrong current password → 401 INVALID_CREDENTIALS (same as MFA disable),
   *   rate-limited per user+IP with the login policy, so a stolen access
   *   token can't be used to brute-force the password.
   * - Every OTHER session is revoked; the caller's current one survives. A
   *   password change is the standard "kick anyone else out" moment.
   * - Notifies the user (security alert) and writes `user.password_changed`
   *   to the audit log — the self-service counterpart of the reset/reissue
   *   events business-rules-and-defaults.md already requires.
   */
  async changePassword(claims: AccessTokenClaims, dto: ChangeOwnPasswordDto, ipAddress?: string): Promise<void> {
    if (dto.currentPassword === dto.newPassword) {
      throw new AppException(422, 'PASSWORD_UNCHANGED', 'Choose a password different from your current one.', {
        field: 'newPassword',
      });
    }

    const rateLimitKey = this.rateLimit.key('password-change', claims.userId, ipAddress);
    await this.rateLimit.assertNotLocked(rateLimitKey);

    const current = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, claims.organizationId);
      const { rows } = await client.query<{ password_hash: string }>(
        'SELECT password_hash FROM tenant.users WHERE id = $1',
        [claims.userId],
      );
      return rows[0];
    });
    if (!current) {
      throw new AppException(401, 'UNAUTHENTICATED', 'User no longer exists.');
    }

    if (!(await argon2.verify(current.password_hash, dto.currentPassword))) {
      await this.rateLimit.recordFailure(rateLimitKey, LOGIN_POLICY);
      throw new AppException(401, 'INVALID_CREDENTIALS', 'Your current password is incorrect.', {
        field: 'currentPassword',
      });
    }
    await this.rateLimit.reset(rateLimitKey);

    const newHash = await argon2.hash(dto.newPassword, { type: argon2.argon2id });
    await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, claims.organizationId);
      await client.query(
        `UPDATE tenant.users SET password_hash = $1, must_change_password = false, updated_at = now() WHERE id = $2`,
        [newHash, claims.userId],
      );
      await this.sessions.revokeAllExcept(client, claims.userId, claims.sessionId);
      await this.notifications.create(client, claims.organizationId, claims.userId, 'password_changed');
      await this.auditLogs.record(client, claims.organizationId, claims.userId, 'user.password_changed', {
        resourceType: 'user',
        resourceId: claims.userId,
        ipAddress,
      });
    });
  }

  private toProfile(user: UserProfileRow): LoginResult['user'] {
    return {
      id: user.id,
      organizationId: user.organization_id,
      orgUnitId: user.org_unit_id,
      email: user.email,
      name: user.name,
      role: user.role,
    };
  }
}
