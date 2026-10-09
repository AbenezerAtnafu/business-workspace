import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app-exception';
import { SessionsService } from '../../common/sessions/sessions.service';
import { TokensService } from '../../common/tokens/tokens.service';
import { MailerService } from '../../common/mailer/mailer.service';
import { MailboxesService } from '../mailboxes/mailboxes.service';
import { DomainsService } from '../domains/domains.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { InviteUserDto } from './dto/invite-user.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { ClaimPrimaryMailboxDto } from './dto/claim-primary-mailbox.dto';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';

type Role = 'owner' | 'admin' | 'member';
type UserStatus = 'invited' | 'active' | 'suspended' | 'deleted';

interface UserRow {
  id: string;
  organization_id: string;
  org_unit_id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  must_change_password: boolean;
  last_login_at: Date | null;
  created_at: Date;
}

export interface UserDto {
  id: string;
  organizationId: string;
  orgUnitId: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  /**
   * True until a Path B / reissued temporary password has been replaced
   * (screen-flow-inventory.md Flow 4: the Users list "status reflects
   * mustChangePassword"). Added 2026-10-07 for the Users screens.
   */
  mustChangePassword: boolean;
  /** Null until the account's first completed sign-in. Added 2026-10-07. */
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface InviteResult {
  inviteId: string;
  expiresAt: Date;
}

export interface InviteListItem {
  id: string;
  domainId: string;
  domainName: string;
  localPart: string;
  contactEmail: string;
  role: 'admin' | 'member';
  orgUnitId: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  invitedByName: string;
  createdAt: Date;
}

export interface InvitePreview {
  localPart: string;
  domainName: string;
  organizationName: string;
  invitedByName: string;
  expiresAt: Date;
}

export interface CreateUserResult {
  userId: string;
  email: string;
  temporaryPassword: string;
  mustChangePassword: true;
}

export interface ReissuePasswordResult {
  temporaryPassword: string;
  mustChangePassword: true;
}

/** Shared shape with AuthService.LoginResult — accept-invite issues a real session, same as login. */
export interface SessionResult {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    organizationId: string;
    orgUnitId: string;
    email: string;
    name: string;
    role: Role;
  };
}

// planning/business-rules-and-defaults.md: "high-entropy, randomly
// generated" — no specific byte count is pinned down anywhere in the docs
// (unlike the 32-byte session/auth-token secrets), so this is a judgment
// call: 18 random bytes, base64url-encoded, is a 24-character password with
// ~144 bits of entropy — comfortably high-entropy while still something an
// admin can read aloud or type over the phone (business-rules-and-
// defaults.md's own description of how Path B passwords get relayed:
// "in person, phone, chat").
const TEMP_PASSWORD_BYTES = 18;
// business-rules-and-defaults.md: "Invite link token: single-use, expires
// after 7 days" — enforced by tenant.invites.expires_at's own DEFAULT, not
// repeated here.

/**
 * User Management — claude/srs.md §7.3, architecture/api-contract.md §3.
 * Implementation-plan Step 1.6. Owns both onboarding paths (Path A via
 * tenant.invites, Path B direct), the generalized admin-triggered password
 * reissue, role/status/org-unit changes, and ownership transfer. Invite
 * send/list/revoke and account creation/update live in one service (not
 * split like OrgUnitsService/GroupsService were) because every one of
 * these flows shares the same domain-verification (DomainsService, Step
 * 2.2) + slot-collision (MailboxesService) preconditions — splitting them
 * would just duplicate that transaction logic across two services.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly mailboxes: MailboxesService,
    private readonly domains: DomainsService,
    private readonly mailer: MailerService,
    private readonly sessions: SessionsService,
    private readonly tokens: TokensService,
    private readonly configService: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly auditLogs: AuditLogsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /**
   * GET /users — "List org members." Excludes soft-deleted accounts
   * (status = 'deleted') by default: DELETE /users/{userId} is a tombstone,
   * not a real removal (see remove() below for why), and a deleted account
   * cluttering the live directory would be confusing — there's no
   * documented `?includeDeleted=` flag, and GET /users/{userId} (by id) is
   * the escape hatch for looking one up specifically. No pagination meta,
   * same precedent as GET /org-units and GET /groups.
   */
  async list(organizationId: string): Promise<UserDto[]> {
    const rows = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const { rows } = await client.query<UserRow>(
        `SELECT id, organization_id, org_unit_id, email, name, role, status, must_change_password, last_login_at, created_at
         FROM tenant.users WHERE status <> 'deleted' ORDER BY created_at`,
      );
      return rows;
    });
    return rows.map((r) => this.toDto(r));
  }

  /** GET /users/{userId} — by id, regardless of status (an admin drilling into a specific record, deleted included). */
  async getById(organizationId: string, userId: string): Promise<UserDto> {
    const row = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      return this.findAnyByIdOrThrow(client, userId);
    });
    return this.toDto(row);
  }

  /**
   * POST /users/invite — Path A. InviteUserDto's role is already restricted
   * to 'admin'/'member' at the DTO level (never 'owner' — ownership moves
   * only via transferOwnership), so no extra guard needed here.
   */
  async invite(organizationId: string, inviterUserId: string, dto: InviteUserDto): Promise<InviteResult> {
    // ADR-011: every invite sends a real email from the platform, so an org
    // (or a compromised admin account) can't turn it into a spam cannon.
    // Counted per organization, before any work, whether or not it succeeds.
    await this.rateLimit.consume(
      this.rateLimit.key('invite', organizationId, 'org'),
      this.rateLimit.quota('invitesPerOrgPerHour'),
    );
    const { inviteId, expiresAt, token, contactEmail, domainName, localPart, fromAddress } = await this.db.withTransaction(
      async (client) => {
        await this.db.setTenantContext(client, organizationId);
        const domain = await this.domains.findVerifiedDomainOrThrow(client, organizationId, dto.domainId);
        await this.mailboxes.assertSlotAvailable(client, dto.domainId, dto.localPart);
        const orgUnitId = dto.orgUnitId
          ? await this.assertOrgUnitExists(client, dto.orgUnitId)
          : await this.findRootOrgUnitId(client, organizationId);

        // business-rules-and-defaults.md's invite-delivery exception: "the
        // platform can send from a reserved address like
        // invitations@<org's primary domain>". Falls back to the mailer's
        // own configured default (SMTP_RELAY_FROM) when the org hasn't set
        // a primary domain yet — a real gap in this method as first built
        // in Step 1.6, which had no Domains module yet to source this from
        // and silently used the global default unconditionally.
        const primaryDomainName = await this.domains.findPrimaryDomainName(client, organizationId);

        const token = randomBytes(32).toString('hex');
        const { rows } = await client.query<{ id: string; expires_at: Date }>(
          `INSERT INTO tenant.invites
             (organization_id, domain_id, local_part, contact_email, role, org_unit_id, token, invited_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, expires_at`,
          [
            organizationId,
            dto.domainId,
            dto.localPart,
            dto.contactEmail,
            dto.role ?? 'member',
            orgUnitId,
            token,
            inviterUserId,
          ],
        );

        return {
          inviteId: rows[0].id,
          expiresAt: rows[0].expires_at,
          token,
          contactEmail: dto.contactEmail,
          domainName: domain.domainName,
          localPart: dto.localPart,
          fromAddress: primaryDomainName ? `invitations@${primaryDomainName}` : undefined,
        };
      },
    );

    // Sent after commit, not inside the transaction — a mail-send failure
    // must never roll back a successfully created invite (the admin can
    // always resend via the same accept link once the issue is fixed,
    // since GET /invites still lists it).
    const acceptUrl = `${this.configService.get<string>('appBaseUrl')}/accept-invite?token=${token}`;
    await this.mailer.send({
      to: contactEmail,
      from: fromAddress,
      subject: "You've been invited to join on Business Workspace Platform",
      text:
        `You've been invited to join as ${localPart}@${domainName}.\n\n` +
        `Accept your invite within the next 7 days:\n\n${acceptUrl}\n\n` +
        `If you weren't expecting this, you can ignore this email.`,
    });

    return { inviteId, expiresAt };
  }

  /** GET /invites — "List pending invites" (accepted_at IS NULL; not filtered by expiry, so an admin can see and revoke an expired one). */
  async listInvites(organizationId: string): Promise<InviteListItem[]> {
    const rows = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const { rows } = await client.query<{
        id: string;
        domain_id: string;
        domain_name: string;
        local_part: string;
        contact_email: string;
        role: 'admin' | 'member';
        org_unit_id: string | null;
        expires_at: Date;
        accepted_at: Date | null;
        invited_by_name: string;
        created_at: Date;
      }>(
        `SELECT i.id, i.domain_id, d.domain_name, i.local_part, i.contact_email, i.role, i.org_unit_id,
                i.expires_at, i.accepted_at, u.name AS invited_by_name, i.created_at
         FROM tenant.invites i
         JOIN control.domains d ON d.id = i.domain_id
         JOIN tenant.users u ON u.id = i.invited_by
         WHERE i.accepted_at IS NULL
         ORDER BY i.created_at DESC`,
      );
      return rows;
    });

    return rows.map((r) => ({
      id: r.id,
      domainId: r.domain_id,
      domainName: r.domain_name,
      localPart: r.local_part,
      contactEmail: r.contact_email,
      role: r.role,
      orgUnitId: r.org_unit_id,
      expiresAt: r.expires_at,
      acceptedAt: r.accepted_at,
      invitedByName: r.invited_by_name,
      createdAt: r.created_at,
    }));
  }

  /** DELETE /invites/{inviteId} — "Revoke a pending invite." Already-accepted or missing/cross-org invites collapse to the same 404 (api-contract.md §0). */
  async revokeInvite(organizationId: string, inviteId: string): Promise<void> {
    const { rowCount } = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      return client.query('DELETE FROM tenant.invites WHERE id = $1 AND accepted_at IS NULL', [inviteId]);
    });
    if (!rowCount) {
      throw new AppException(404, 'NOT_FOUND', 'Pending invite not found.');
    }
  }

  /**
   * GET /invites/{token} — public, token-scoped preview. Runs the initial
   * lookup via queryBypassingRls() (migrations/008_app_bootstrap_role.sql
   * — ADR-005): the organization isn't known until the token resolves it,
   * exactly the same bootstrap reasoning as AuthTokensService.findValid.
   * Once the organization IS known, the rest of the read goes through an
   * ordinary RLS-scoped transaction.
   */
  async previewInvite(token: string): Promise<InvitePreview> {
    const invite = await this.findInviteByTokenOrThrow(token);

    return this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, invite.organizationId);
      const { rows } = await client.query<{ domain_name: string; organization_name: string; invited_by_name: string }>(
        `SELECT d.domain_name, o.name AS organization_name, u.name AS invited_by_name
         FROM control.domains d, control.organizations o, tenant.users u
         WHERE d.id = $1 AND o.id = $2 AND u.id = $3`,
        [invite.domainId, invite.organizationId, invite.invitedBy],
      );
      const row = rows[0];
      return {
        localPart: invite.localPart,
        domainName: row.domain_name,
        organizationName: row.organization_name,
        invitedByName: row.invited_by_name,
        expiresAt: invite.expiresAt,
      };
    });
  }

  /** POST /invites/{token}/accept — public. Creates the mailbox + user rows now, in one transaction, and issues a real session (same shape as login). */
  async acceptInvite(token: string, dto: AcceptInviteDto, deviceInfo?: string, ipAddress?: string): Promise<SessionResult> {
    const invite = await this.findInviteByTokenOrThrow(token);

    const result = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, invite.organizationId);

      const domain = await this.domains.findVerifiedDomainOrThrow(client, invite.organizationId, invite.domainId);
      // Re-checked here, not just at invite-send time: a Path B create (or
      // a second invite, if one were ever allowed) could have taken this
      // exact slot while this invite was outstanding. excludeInviteId is
      // this invite's own id — see MailboxesService.assertSlotAvailable's
      // doc comment for why that's required, not optional, here.
      await this.mailboxes.assertSlotAvailable(client, invite.domainId, invite.localPart, invite.id);
      const orgUnitId = invite.orgUnitId ?? (await this.findRootOrgUnitId(client, invite.organizationId));

      const mailboxId = await this.mailboxes.createMailbox(client, invite.organizationId, invite.domainId, invite.localPart, null);
      const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });
      const email = `${invite.localPart}@${domain.domainName}`;

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO tenant.users
           (organization_id, org_unit_id, email, primary_mailbox_id, name, password_hash, role, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
         RETURNING id`,
        [invite.organizationId, orgUnitId, email, mailboxId, dto.name, passwordHash, invite.role],
      );
      const userId = rows[0].id;

      await client.query('UPDATE tenant.mailboxes SET user_id = $1 WHERE id = $2', [userId, mailboxId]);
      await client.query(
        'INSERT INTO control.user_directory (email, organization_id, user_id) VALUES ($1, $2, $3)',
        [email, invite.organizationId, userId],
      );
      await client.query('UPDATE tenant.invites SET accepted_at = now() WHERE id = $1', [invite.id]);

      // Step 3.1: notify Owner/Admins a new teammate joined — but not the
      // new user themselves. An invite can carry role 'admin', so the new
      // account may already be in the admin set it fans out to; excluding
      // it explicitly (fixed 2026-10-07 — an admin invitee used to get a
      // "user joined" notification about their own join).
      await this.notifications.notifyAdmins(
        client,
        invite.organizationId,
        'user_joined',
        { userId, email, name: dto.name, role: invite.role },
        userId,
      );

      // Step 3.2: claude/srs.md §7.10 MVP event "User creation." This is
      // the one audited user-creation path with no authenticated caller at
      // all (POST /invites/{token}/accept is @Public()) — the actor is the
      // new user themselves, completing an invite the admin already sent
      // (that invite's own send-time actor, invite.invitedBy, is captured
      // in metadata instead, since it's genuinely relevant context here but
      // isn't who performed THIS action).
      await this.auditLogs.record(client, invite.organizationId, userId, 'user.created', {
        resourceType: 'user',
        resourceId: userId,
        ipAddress,
        metadata: { email, role: invite.role, invitedBy: invite.invitedBy },
      });

      // Accepting an invite signs the new user straight in (2026-10-07: now counted as a sign-in).
      await client.query('UPDATE tenant.users SET last_login_at = now() WHERE id = $1', [userId]);
      const { sessionId, refreshToken } = await this.sessions.issue(client, invite.organizationId, userId, deviceInfo, ipAddress);

      return { userId, orgUnitId, email, name: dto.name, role: invite.role, sessionId, refreshToken };
    });

    const accessToken = this.tokens.signAccessToken({
      organizationId: invite.organizationId,
      userId: result.userId,
      role: result.role,
      sessionId: result.sessionId,
    });

    return {
      accessToken,
      refreshToken: result.refreshToken,
      user: {
        id: result.userId,
        organizationId: invite.organizationId,
        orgUnitId: result.orgUnitId,
        email: result.email,
        name: result.name,
        role: result.role,
      },
    };
  }

  /** POST /users — Path B. */
  async createDirect(organizationId: string, actorUserId: string, dto: CreateUserDto): Promise<CreateUserResult> {
    const temporaryPassword = this.generateTempPassword();
    const passwordHash = await argon2.hash(temporaryPassword, { type: argon2.argon2id });

    const { userId, email } = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const domain = await this.domains.findVerifiedDomainOrThrow(client, organizationId, dto.domainId);
      await this.mailboxes.assertSlotAvailable(client, dto.domainId, dto.localPart);
      const orgUnitId = dto.orgUnitId
        ? await this.assertOrgUnitExists(client, dto.orgUnitId)
        : await this.findRootOrgUnitId(client, organizationId);

      const mailboxId = await this.mailboxes.createMailbox(client, organizationId, dto.domainId, dto.localPart, null);
      const email = `${dto.localPart}@${domain.domainName}`;

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO tenant.users
           (organization_id, org_unit_id, email, primary_mailbox_id, name, password_hash, role, status, must_change_password)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', true)
         RETURNING id`,
        [organizationId, orgUnitId, email, mailboxId, dto.name, passwordHash, dto.role ?? 'member'],
      );
      const userId = rows[0].id;

      await client.query('UPDATE tenant.mailboxes SET user_id = $1 WHERE id = $2', [userId, mailboxId]);
      await client.query(
        'INSERT INTO control.user_directory (email, organization_id, user_id) VALUES ($1, $2, $3)',
        [email, organizationId, userId],
      );

      // Step 3.1: same 'user_joined' fan-out as the invite-accept path
      // above — the other onboarding path produces the same kind of event,
      // with the same self-exclusion (Path B can create an admin directly).
      await this.notifications.notifyAdmins(
        client,
        organizationId,
        'user_joined',
        { userId, email, name: dto.name, role: dto.role ?? 'member' },
        userId,
      );

      await this.auditLogs.record(client, organizationId, actorUserId, 'user.created', {
        resourceType: 'user',
        resourceId: userId,
        metadata: { email, role: dto.role ?? 'member' },
      });

      return { userId, email };
    });

    return { userId, email, temporaryPassword, mustChangePassword: true };
  }

  /**
   * POST /users/{userId}/password/reissue — "callable on any existing
   * account... never logged or stored in plaintext" (business-rules-and-
   * defaults.md). Same temp-password mechanism as Path B.
   */
  async reissuePassword(organizationId: string, actorUserId: string, targetUserId: string): Promise<ReissuePasswordResult> {
    // ADR-011: each reissue signs the target out everywhere — repeated
    // reissues are a way to lock someone out. Per target, then per org.
    await this.rateLimit.consume(
      this.rateLimit.key('reissue-user', targetUserId, 'org'),
      this.rateLimit.quota('reissuesPerUserPerHour'),
    );
    await this.rateLimit.consume(
      this.rateLimit.key('reissue-org', organizationId, 'org'),
      this.rateLimit.quota('reissuesPerOrgPerHour'),
    );
    const temporaryPassword = this.generateTempPassword();
    const passwordHash = await argon2.hash(temporaryPassword, { type: argon2.argon2id });

    await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const target = await this.findAnyByIdOrThrow(client, targetUserId);
      // findAnyByIdOrThrow returns deleted rows too (GET /users/{id} needs
      // that); a deleted account can't sign in, so reissuing onto one is
      // always a mistake — same 404 as a missing user.
      if (target.status === 'deleted') {
        throw new AppException(404, 'NOT_FOUND', 'User not found.');
      }
      // Added 2026-10-07. An Admin who could reissue the Owner's password
      // could sign in as the Owner and act with full Owner rights, which
      // contradicts the permission matrix's role-assignment row ("Admin: can
      // assign Member/Admin, not Owner"). The Owner's own credentials are
      // theirs to manage: self-service change/reset, or a transfer first.
      if (target.role === 'owner' && targetUserId !== actorUserId) {
        throw new AppException(
          403,
          'CANNOT_REISSUE_OWNER',
          "Only the Owner can manage the Owner's password. Ask them to reset it themselves.",
        );
      }
      await client.query(
        'UPDATE tenant.users SET password_hash = $1, must_change_password = true, updated_at = now() WHERE id = $2',
        [passwordHash, targetUserId],
      );
      // Added 2026-10-07. Reissue is also "how an Admin immediately cuts
      // off a suspected-compromised or offboarding account" (srs.md §7.3),
      // so every existing session must stop being able to refresh. Before
      // this, someone already signed in kept their session indefinitely.
      await this.sessions.revokeAllExcept(client, targetUserId);
      // Step 3.1: notify the affected user — they'll see this once they log
      // in with the new temporary password. Never the temp password itself
      // in the payload, same discipline business-rules-and-defaults.md
      // requires of audit-log metadata.
      await this.notifications.create(client, organizationId, targetUserId, 'password_reissued');

      // Step 3.2: planning/business-rules-and-defaults.md's "Audit logs"
      // section explicitly names "admin-triggered password reissues" as a
      // required audit event, alongside the same never-the-plaintext rule
      // the notification above already follows.
      await this.auditLogs.record(client, organizationId, actorUserId, 'user.password_reissued', {
        resourceType: 'user',
        resourceId: targetUserId,
      });
    });

    return { temporaryPassword, mustChangePassword: true };
  }

  /**
   * PATCH /users/{userId} — role / status / org-unit. Two invariants
   * beyond the literal contract text, both necessary to keep "exactly one
   * Owner at all times" true (business-rules-and-defaults.md):
   *
   *  1. Assigning role: 'owner' here is explicitly rejected by the contract
   *     (422) — ownership only moves via transferOwnership.
   *  2. Changing role AWAY from 'owner', or suspending the current Owner,
   *     would leave the organization with zero Owners — not spelled out
   *     for the role-change case specifically, but the same 409 SOLE_OWNER
   *     the contract DOES specify for suspend/delete applies by the same
   *     reasoning: a role PATCH is just another way to stop being Owner.
   */
  async update(organizationId: string, actorUserId: string, targetUserId: string, dto: UpdateUserDto): Promise<UserDto> {
    const row = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const current = await this.findAnyByIdOrThrow(client, targetUserId);
      // Added 2026-10-07: a soft-deleted account is final. Without this,
      // PATCH { status: 'active' } quietly brought a deleted user back,
      // sessions and all. "Reactivate" (srs.md §7.3) means un-suspend.
      if (current.status === 'deleted') {
        throw new AppException(404, 'NOT_FOUND', 'User not found.');
      }

      if (dto.role === 'owner') {
        throw new AppException(422, 'CANNOT_ASSIGN_OWNER', 'Use POST /users/{userId}/transfer-ownership to change the Owner.');
      }
      if (current.role === 'owner' && (dto.role !== undefined || dto.status === 'suspended')) {
        throw new AppException(
          409,
          'SOLE_OWNER',
          'This account is the sole Owner — transfer ownership before changing its role or suspending it.',
        );
      }
      if (dto.orgUnitId !== undefined) {
        await this.assertOrgUnitExists(client, dto.orgUnitId);
      }

      const { rows } = await client.query<UserRow>(
        `UPDATE tenant.users
         SET role = COALESCE($1, role),
             status = COALESCE($2, status),
             org_unit_id = COALESCE($3, org_unit_id),
             updated_at = now()
         WHERE id = $4
         RETURNING id, organization_id, org_unit_id, email, name, role, status, must_change_password, last_login_at, created_at`,
        [dto.role ?? null, dto.status ?? null, dto.orgUnitId ?? null, targetUserId],
      );
      const row = rows[0];

      // Step 3.2: claude/srs.md §7.10 MVP event "Role changes" — logged
      // separately from a status change (suspend/reactivate) when both are
      // present in the same PATCH, since they're two distinct named events
      // in the taxonomy, not one. orgUnitId reassignment via this same
      // endpoint is NOT logged as its own event — the MVP list names "Role
      // changes" specifically, not a general user-record-changed catch-all,
      // and org-unit *structure* changes (create/rename/delete) are already
      // covered by org_unit.* above; a deliberate scope line, not an
      // oversight.
      if (dto.role !== undefined) {
        await this.auditLogs.record(client, organizationId, actorUserId, 'user.role_changed', {
          resourceType: 'user',
          resourceId: targetUserId,
          metadata: { fromRole: current.role, toRole: dto.role },
        });
      }
      if (dto.status !== undefined) {
        await this.auditLogs.record(client, organizationId, actorUserId, 'user.status_changed', {
          resourceType: 'user',
          resourceId: targetUserId,
          metadata: { fromStatus: current.status, toStatus: dto.status },
        });
      }

      return row;
    });
    return this.toDto(row);
  }

  /**
   * POST /users/{userId}/transfer-ownership — "(caller ... becomes Admin;
   * target becomes Owner)," one atomic operation so there's never a moment
   * with zero or two Owners. Two guards beyond the literal contract text:
   * transferring to yourself is a no-op that would be confusing to allow
   * silently, and transferring to a non-active account would hand
   * ownership to someone who can't even log in.
   */
  async transferOwnership(organizationId: string, callerUserId: string, targetUserId: string): Promise<void> {
    if (targetUserId === callerUserId) {
      throw new AppException(422, 'CANNOT_TRANSFER_TO_SELF', 'You are already the Owner.');
    }

    await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const target = await this.findAnyByIdOrThrow(client, targetUserId);
      if (target.status !== 'active') {
        throw new AppException(422, 'TARGET_NOT_ACTIVE', 'Ownership can only be transferred to an active account.');
      }

      await client.query("UPDATE tenant.users SET role = 'admin', updated_at = now() WHERE id = $1", [callerUserId]);
      await client.query("UPDATE tenant.users SET role = 'owner', updated_at = now() WHERE id = $1", [targetUserId]);

      await this.auditLogs.record(client, organizationId, callerUserId, 'user.ownership_transferred', {
        resourceType: 'user',
        resourceId: targetUserId,
        metadata: { fromUserId: callerUserId, toUserId: targetUserId },
      });
    });
  }

  /**
   * DELETE /users/{userId} — a soft delete (status = 'deleted'), not a row
   * removal: tenant.mailboxes.user_id and tenant.users.primary_mailbox_id
   * FK each other with no cascade path that safely unwinds both sides, and
   * nothing in the docs calls for actually destroying a user's mail data
   * on account deletion (a mailbox living on past its user's deletion, to
   * be reassigned or cleaned up separately, is the same pattern as a
   * departing employee's mailbox being kept for continuity — architecture/
   * domain-and-email-flow.md never mentions mailbox deletion as a side
   * effect of user deletion either). Every existing session is revoked —
   * deletion should cut access immediately, not just hide the account from
   * GET /users.
   */
  async remove(organizationId: string, actorUserId: string, targetUserId: string): Promise<void> {
    await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const current = await this.findAnyByIdOrThrow(client, targetUserId);
      if (current.role === 'owner') {
        throw new AppException(409, 'SOLE_OWNER', 'The sole Owner cannot be deleted — transfer ownership first.');
      }

      await client.query("UPDATE tenant.users SET status = 'deleted', updated_at = now() WHERE id = $1", [targetUserId]);
      await this.sessions.revokeAllExcept(client, targetUserId);
      // Added 2026-10-07: a deleted account leaves its groups (and so stops
      // inheriting any group-granted mailbox access) and loses its direct
      // mailbox grants. Nothing can ever act on either again, and leaving
      // them made deleted people show up in Group Detail.
      await client.query('DELETE FROM tenant.group_members WHERE user_id = $1', [targetUserId]);
      await client.query('DELETE FROM tenant.mailbox_access WHERE user_id = $1', [targetUserId]);
      // Added 2026-10-07: free the sign-in address. control.user_directory's
      // email is the PRIMARY KEY, so leaving the row made any later account at
      // the same address (after its mailbox was deleted and recreated) fail
      // with a raw unique-violation 500. A deleted account can't sign in
      // anyway (status check in AuthService.login).
      await client.query('DELETE FROM control.user_directory WHERE user_id = $1 AND organization_id = $2', [
        targetUserId,
        organizationId,
      ]);

      await this.auditLogs.record(client, organizationId, actorUserId, 'user.deleted', {
        resourceType: 'user',
        resourceId: targetUserId,
        metadata: { email: current.email },
      });
    });
  }

  /**
   * POST /me/primary-mailbox — architecture/api-contract.md §2 ("Owner
   * bootstrap"). Implemented here, not AuthService, because it needs the
   * same mailbox/domain-aware transaction shape as every other identity
   * change in this service and touches no auth-specific state (tokens,
   * sessions) at all — it's exposed on AuthController purely because it
   * belongs alongside the rest of the `/me/*` routes, per api-contract.md
   * §2's own route table listing it there.
   *
   * Two guards beyond the contract's literal "sets primary_mailbox_id,
   * recomputes the cached email column, deletes the old control.
   * user_directory row... inserts the new one":
   *
   *  1. The target mailbox's `user_id` must equal the caller — prevents one
   *     user from claiming a mailbox someone else (or no one, for a shared
   *     mailbox) owns as their own login identity. Invented code (`422
   *     MAILBOX_NOT_OWNED_BY_CALLER`) — not in api-contract.md's text, same
   *     pattern as DOMAIN_HAS_PENDING_INVITES (ADR-006).
   *  2. The caller's `primary_mailbox_id` must currently be NULL (`409`) —
   *     api-contract.md §2 describes this as "exercised exactly once per
   *     organization." Allowing a second call would silently orphan the
   *     caller's current `control.user_directory` row via a second
   *     delete+insert with no transfer/reassignment ceremony, unlike every
   *     other identity change this module makes (ownership transfer, role
   *     change) which all have an explicit guard against exactly this kind
   *     of silent double-application.
   */
  async claimPrimaryMailbox(organizationId: string, callerUserId: string, dto: ClaimPrimaryMailboxDto): Promise<UserDto> {
    const row = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);

      const { rows: callerRows } = await client.query<{ id: string; email: string; primary_mailbox_id: string | null }>(
        'SELECT id, email, primary_mailbox_id FROM tenant.users WHERE id = $1',
        [callerUserId],
      );
      const caller = callerRows[0];
      if (!caller) {
        throw new AppException(404, 'NOT_FOUND', 'User not found.');
      }
      if (caller.primary_mailbox_id) {
        throw new AppException(409, 'PRIMARY_MAILBOX_ALREADY_SET', 'You already have a primary mailbox.');
      }

      const { rows: mailboxRows } = await client.query<{
        id: string;
        user_id: string | null;
        local_part: string;
        domain_id: string;
      }>(`SELECT id, user_id, local_part, domain_id FROM tenant.mailboxes WHERE id = $1 AND status <> 'deleted'`, [
        dto.mailboxId,
      ]);
      const mailbox = mailboxRows[0];
      if (!mailbox) {
        throw new AppException(404, 'NOT_FOUND', 'Mailbox not found.');
      }
      if (mailbox.user_id !== callerUserId) {
        throw new AppException(
          422,
          'MAILBOX_NOT_OWNED_BY_CALLER',
          'You can only claim a mailbox created with assignToSelf for your own account.',
        );
      }

      const { rows: domainRows } = await client.query<{ domain_name: string }>(
        'SELECT domain_name FROM control.domains WHERE id = $1',
        [mailbox.domain_id],
      );
      const newEmail = `${mailbox.local_part}@${domainRows[0].domain_name}`;

      const { rows: updated } = await client.query<UserRow>(
        `UPDATE tenant.users SET primary_mailbox_id = $1, email = $2, updated_at = now()
         WHERE id = $3
         RETURNING id, organization_id, org_unit_id, email, name, role, status, must_change_password, last_login_at, created_at`,
        [dto.mailboxId, newEmail, callerUserId],
      );

      await client.query('DELETE FROM control.user_directory WHERE email = $1', [caller.email]);
      await client.query(
        'INSERT INTO control.user_directory (email, organization_id, user_id) VALUES ($1, $2, $3)',
        [newEmail, organizationId, callerUserId],
      );

      return updated[0];
    });
    return this.toDto(row);
  }

  // --- internal helpers -------------------------------------------------

  private generateTempPassword(): string {
    return randomBytes(TEMP_PASSWORD_BYTES).toString('base64url');
  }

  private async findRootOrgUnitId(client: PoolClient, organizationId: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM tenant.org_units WHERE organization_id = $1 AND parent_org_unit_id IS NULL',
      [organizationId],
    );
    // Can't happen outside a corrupted database — every org gets exactly
    // one root unit at bootstrap (data-model.md) — but fail loudly rather
    // than inserting a user with a null org_unit_id (a NOT NULL column) if
    // it somehow did.
    if (!rows[0]) {
      throw new AppException(500, 'INTERNAL_SERVER_ERROR', 'Organization has no root org unit.');
    }
    return rows[0].id;
  }

  /** 404s if missing — also used to validate a caller-supplied orgUnitId belongs to this org (RLS already scopes the query). */
  private async assertOrgUnitExists(client: PoolClient, orgUnitId: string): Promise<string> {
    const { rows } = await client.query('SELECT 1 FROM tenant.org_units WHERE id = $1', [orgUnitId]);
    if (rows.length === 0) {
      throw new AppException(404, 'NOT_FOUND', 'Org unit not found.');
    }
    return orgUnitId;
  }

  /** Unlike list()'s default, this includes 'deleted' — an explicit by-id lookup/action always sees the real row. */
  private async findAnyByIdOrThrow(client: PoolClient, userId: string): Promise<UserRow> {
    const { rows } = await client.query<UserRow>(
      `SELECT id, organization_id, org_unit_id, email, name, role, status, must_change_password, last_login_at, created_at
       FROM tenant.users WHERE id = $1`,
      [userId],
    );
    if (rows.length === 0) {
      throw new AppException(404, 'NOT_FOUND', 'User not found.');
    }
    return rows[0];
  }

  /**
   * Shared by previewInvite/acceptInvite. Uses queryBypassingRls() — see
   * migrations/008_app_bootstrap_role.sql and ADR-005: the organization
   * isn't known until the token resolves it, and the token itself is the
   * unguessable secret that makes an unscoped lookup safe.
   */
  private async findInviteByTokenOrThrow(token: string): Promise<{
    id: string;
    organizationId: string;
    domainId: string;
    localPart: string;
    role: 'admin' | 'member';
    orgUnitId: string | null;
    invitedBy: string;
    expiresAt: Date;
    acceptedAt: Date | null;
  }> {
    const { rows } = await this.db.queryBypassingRls<{
      id: string;
      organization_id: string;
      domain_id: string;
      local_part: string;
      role: 'admin' | 'member';
      org_unit_id: string | null;
      invited_by: string;
      expires_at: Date;
      accepted_at: Date | null;
    }>(
      `SELECT id, organization_id, domain_id, local_part, role, org_unit_id, invited_by, expires_at, accepted_at
       FROM tenant.invites WHERE token = $1`,
      [token],
    );
    const invite = rows[0];
    if (!invite) {
      throw new AppException(404, 'NOT_FOUND', 'Invite not found.');
    }
    if (invite.accepted_at !== null || invite.expires_at.getTime() < Date.now()) {
      throw new AppException(410, 'INVITE_NOT_ACTIVE', 'This invite is no longer active — ask your admin for a new one.');
    }
    return {
      id: invite.id,
      organizationId: invite.organization_id,
      domainId: invite.domain_id,
      localPart: invite.local_part,
      role: invite.role,
      orgUnitId: invite.org_unit_id,
      invitedBy: invite.invited_by,
      expiresAt: invite.expires_at,
      acceptedAt: invite.accepted_at,
    };
  }

  private toDto(row: UserRow): UserDto {
    return {
      id: row.id,
      organizationId: row.organization_id,
      orgUnitId: row.org_unit_id,
      email: row.email,
      name: row.name,
      role: row.role,
      status: row.status,
      mustChangePassword: row.must_change_password,
      lastLoginAt: row.last_login_at,
      createdAt: row.created_at,
    };
  }
}
