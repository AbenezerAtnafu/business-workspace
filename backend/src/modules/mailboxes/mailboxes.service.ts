import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { DomainsService } from '../domains/domains.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { AppException } from '../../common/errors/app-exception';
import { AccessTokenClaims } from '../../common/tokens/tokens.service';
import { CreateMailboxDto } from './dto/create-mailbox.dto';
import { UpdateMailboxDto } from './dto/update-mailbox.dto';
import { CreateAliasDto } from './dto/create-alias.dto';
import { CreateAccessGrantDto } from './dto/create-access-grant.dto';
import { UpdateAccessGrantDto } from './dto/update-access-grant.dto';

type MailboxStatus = 'active' | 'suspended' | 'deleted';
type AccessLevel = 'read_only' | 'send_as' | 'manage';

interface MailboxJoinRow {
  id: string;
  organization_id: string;
  user_id: string | null;
  domain_id: string;
  local_part: string;
  quota_bytes: string | number;
  status: MailboxStatus;
  created_at: Date;
  domain_name: string;
  user_name: string | null;
}

export interface AliasDto {
  id: string;
  localPart: string;
  email: string;
  createdAt: Date;
}

export interface MailboxListItemDto {
  id: string;
  domainId: string;
  domainName: string;
  localPart: string;
  email: string;
  userId: string | null;
  userName: string | null;
  quotaBytes: number;
  status: MailboxStatus;
  createdAt: Date;
}

export interface MailboxDetailDto extends MailboxListItemDto {
  aliases: AliasDto[];
}

export interface AccessGrantDto {
  id: string;
  mailboxId: string;
  userId: string | null;
  groupId: string | null;
  targetName: string;
  accessLevel: AccessLevel;
  grantedAt: Date;
}

const MAILBOX_SELECT = `
  SELECT m.id, m.organization_id, m.user_id, m.domain_id, m.local_part, m.quota_bytes, m.status, m.created_at,
         d.domain_name, u.name AS user_name
  FROM tenant.mailboxes m
  JOIN control.domains d ON d.id = m.domain_id
  LEFT JOIN tenant.users u ON u.id = m.user_id
`;

/**
 * Business Email — provisioning — claude/srs.md §7.6, architecture/
 * api-contract.md §7, implementation-plan Step 2.3. Owns the full
 * mailbox/alias/access-grant surface: create/suspend/delete/quota, alias
 * local parts (`tenant.mailbox_aliases`), and access grants to a user OR a
 * group (`tenant.mailbox_access`) — the group grant path reads
 * `tenant.group_members`/`tenant.groups` directly, the same way
 * UsersService reads `tenant.org_units` directly, rather than taking a
 * dependency on GroupsService for a single existence check.
 *
 * `assertSlotAvailable`/`createMailbox` predate this step (Step 1.6, see
 * their own doc comments below) — both onboarding paths in UsersService
 * still call them exactly as before. This step's one change to
 * `assertSlotAvailable` is real, not cosmetic: it now also checks
 * `tenant.mailbox_aliases` for a collision, in both directions (a new
 * mailbox colliding with an existing alias, and — now that aliases can be
 * created at all — a new alias colliding with an existing mailbox, invite,
 * or other alias). Before this step, the alias table didn't exist as a
 * writable surface, so nothing ever exercised that gap; it would have let
 * `support@acme.com` be provisioned as both a real mailbox and someone
 * else's alias target at the same time.
 */
@Injectable()
export class MailboxesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly domains: DomainsService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /**
   * architecture/data-model.md: "Both paths write to the same domain_id +
   * local_part space, so before creating anything, check both
   * tenant.mailboxes (existing) and tenant.invites (pending, accepted_at IS
   * NULL) for a collision." Step 2.3 adds a third table to that check:
   * tenant.mailbox_aliases — the same domain_id+local_part space an alias
   * occupies is just as real a collision as an existing mailbox or invite,
   * and this is the one method every creation path (mailbox, alias, invite,
   * Path B direct-create) funnels through, so extending it here closes the
   * gap everywhere at once rather than needing a parallel check bolted onto
   * createAlias alone.
   *
   * Also newly filters `status <> 'deleted'` on the mailboxes check — dead
   * weight before this step (nothing could soft-delete a mailbox yet), but
   * required now that `remove()` below does exactly that: a deleted
   * mailbox's slot must become available again for reuse, the same way a
   * revoked invite already frees its slot.
   *
   * `excludeInviteId` matters for exactly one call site (UsersService.
   * acceptInvite's re-check of its own still-pending invite row) — see the
   * original Step 1.6 note this doc comment carries forward: without
   * excluding it, every invite acceptance would fail by colliding with
   * itself.
   */
  async assertSlotAvailable(
    client: PoolClient,
    domainId: string,
    localPart: string,
    excludeInviteId?: string,
  ): Promise<void> {
    const { rows: mailboxRows } = await client.query(
      `SELECT 1 FROM tenant.mailboxes WHERE domain_id = $1 AND local_part = $2 AND status <> 'deleted'`,
      [domainId, localPart],
    );
    if (mailboxRows.length > 0) {
      throw new AppException(409, 'MAILBOX_SLOT_TAKEN', 'This address is already in use.');
    }

    const { rows: inviteRows } = await client.query(
      `SELECT 1 FROM tenant.invites
       WHERE domain_id = $1 AND local_part = $2 AND accepted_at IS NULL
         AND ($3::uuid IS NULL OR id <> $3)`,
      [domainId, localPart, excludeInviteId ?? null],
    );
    if (inviteRows.length > 0) {
      throw new AppException(409, 'MAILBOX_SLOT_TAKEN', 'This address already has a pending invite.');
    }

    const { rows: aliasRows } = await client.query(
      `SELECT 1 FROM tenant.mailbox_aliases WHERE domain_id = $1 AND alias_local_part = $2`,
      [domainId, localPart],
    );
    if (aliasRows.length > 0) {
      throw new AppException(409, 'MAILBOX_SLOT_TAKEN', 'This address is already in use as an alias.');
    }
  }

  /**
   * Inserts the tenant.mailboxes row. `userId` is nullable on the table
   * (shared mailboxes have none); Step 1.6's two onboarding paths always
   * pass `null` here and back-fill it with a second UPDATE after the user
   * row exists (data-model.md's documented ordering). Step 2.3's own
   * `create()` below passes a real `userId` directly when `assignToSelf` is
   * set, since there's no user-row-creation step to sequence around there.
   *
   * `quotaBytes` is new in Step 2.3 and deliberately left out of the INSERT
   * column list when omitted, rather than hardcoding the 5 GB default here
   * too — tenant.mailboxes.quota_bytes already carries that default
   * (migration 003), and duplicating the literal in application code would
   * be a second place for that number to drift out of sync with the schema.
   */
  async createMailbox(
    client: PoolClient,
    organizationId: string,
    domainId: string,
    localPart: string,
    userId: string | null,
    quotaBytes?: number,
  ): Promise<string> {
    const { rows } =
      quotaBytes !== undefined
        ? await client.query<{ id: string }>(
            `INSERT INTO tenant.mailboxes (organization_id, user_id, domain_id, local_part, quota_bytes)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [organizationId, userId, domainId, localPart, quotaBytes],
          )
        : await client.query<{ id: string }>(
            `INSERT INTO tenant.mailboxes (organization_id, user_id, domain_id, local_part)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [organizationId, userId, domainId, localPart],
          );
    return rows[0].id;
  }

  /**
   * POST /mailboxes. `assignToSelf` additionally guards that the caller
   * doesn't already have a primary mailbox — not spelled out by
   * api-contract.md's literal text, but required by its own framing of this
   * flag as "the one-time case" (§2): without this guard, a second
   * assignToSelf call would create a second tenant.mailboxes row with
   * user_id pointed at the same caller, which contradicts "one user has
   * exactly one primary login mailbox" (§7) — nothing elsewhere enforces
   * that invariant for mailboxes.user_id itself (only
   * users.primary_mailbox_id carries a real UNIQUE constraint).
   */
  async create(organizationId: string, callerUserId: string, dto: CreateMailboxDto): Promise<MailboxDetailDto> {
    return this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      await this.domains.findVerifiedDomainOrThrow(client, organizationId, dto.domainId);
      await this.assertSlotAvailable(client, dto.domainId, dto.localPart);

      let userId: string | null = null;
      if (dto.assignToSelf) {
        const { rows } = await client.query<{ primary_mailbox_id: string | null }>(
          'SELECT primary_mailbox_id FROM tenant.users WHERE id = $1',
          [callerUserId],
        );
        if (rows[0]?.primary_mailbox_id) {
          throw new AppException(409, 'PRIMARY_MAILBOX_ALREADY_SET', 'You already have a primary mailbox.');
        }
        userId = callerUserId;
      }

      const mailboxId = await this.createMailbox(client, organizationId, dto.domainId, dto.localPart, userId, dto.quotaBytes);

      // Step 3.2: claude/srs.md §7.10 MVP event "Mailbox changes." Actor is
      // the same callerUserId already threaded through for assignToSelf —
      // no new parameter needed, since the caller creating the mailbox and
      // the actor performing the audited action are the same person here.
      await this.auditLogs.record(client, organizationId, callerUserId, 'mailbox.created', {
        resourceType: 'mailbox',
        resourceId: mailboxId,
        metadata: { domainId: dto.domainId, localPart: dto.localPart, assignToSelf: !!dto.assignToSelf },
      });

      const row = await this.findActiveByIdOrThrow(client, organizationId, mailboxId);
      return this.toDetailDto(row, []);
    });
  }

  /**
   * GET /mailboxes. "for a Member returns only their own primary mailbox
   * plus any shared mailboxes they hold a mailbox_access grant on —
   * directly, or through a Group they belong to" (api-contract.md §7); "not
   * the org's full list, which only Owner/Admin see." No pagination meta —
   * same precedent as GET /domains, /org-units, /groups, /users.
   */
  async list(organizationId: string, claims: AccessTokenClaims): Promise<MailboxListItemDto[]> {
    const rows = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);

      if (claims.role === 'owner' || claims.role === 'admin') {
        const { rows } = await client.query<MailboxJoinRow>(
          `${MAILBOX_SELECT} WHERE m.status <> 'deleted' ORDER BY m.created_at`,
        );
        return rows;
      }

      const { rows } = await client.query<MailboxJoinRow>(
        `${MAILBOX_SELECT}
         WHERE m.status <> 'deleted' AND (
           m.user_id = $1
           OR m.id IN (SELECT mailbox_id FROM tenant.mailbox_access WHERE user_id = $1)
           OR m.id IN (
             SELECT mailbox_id FROM tenant.mailbox_access
             WHERE group_id IN (SELECT group_id FROM tenant.group_members WHERE user_id = $1)
           )
         )
         ORDER BY m.created_at`,
        [claims.userId],
      );
      return rows;
    });
    return rows.map((r) => this.toListItemDto(r));
  }

  /** GET /mailboxes/{mailboxId} — "Owner/Admin, or owner/grantee" (api-contract.md §7). Aliases embedded inline — no dedicated GET-aliases endpoint exists in the contract. */
  async getById(organizationId: string, claims: AccessTokenClaims, mailboxId: string): Promise<MailboxDetailDto> {
    return this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const row = await this.findActiveByIdOrThrow(client, organizationId, mailboxId);
      await this.assertReadAccess(client, row, claims);
      const aliases = await this.listAliasesForMailbox(client, mailboxId);
      return this.toDetailDto(row, aliases);
    });
  }

  /** PATCH /mailboxes/{mailboxId} — "Quota / status (suspend)" (api-contract.md §7). Owner/Admin only, enforced by the controller's @Roles(). */
  async update(organizationId: string, actorUserId: string, mailboxId: string, dto: UpdateMailboxDto): Promise<MailboxDetailDto> {
    return this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      await this.findActiveByIdOrThrow(client, organizationId, mailboxId);

      await client.query(
        `UPDATE tenant.mailboxes SET quota_bytes = COALESCE($1, quota_bytes), status = COALESCE($2, status) WHERE id = $3`,
        [dto.quotaBytes ?? null, dto.status ?? null, mailboxId],
      );

      await this.auditLogs.record(client, organizationId, actorUserId, 'mailbox.updated', {
        resourceType: 'mailbox',
        resourceId: mailboxId,
        metadata: { quotaBytes: dto.quotaBytes, status: dto.status },
      });

      const row = await this.findActiveByIdOrThrow(client, organizationId, mailboxId);
      const aliases = await this.listAliasesForMailbox(client, mailboxId);
      return this.toDetailDto(row, aliases);
    });
  }

  /**
   * DELETE /mailboxes/{mailboxId} — "Delete (blocked if it's a user's
   * primary — reassign/delete the user first)" (api-contract.md §7). A soft
   * delete (status = 'deleted'), consistent with DomainsService.remove's
   * own `status <> 'deleted'` guard query, and with UsersService.remove's
   * reasoning for not destroying mail data outright. `422
   * MAILBOX_IS_PRIMARY` isn't a code api-contract.md spells out for this
   * endpoint — it only names the blocking condition in prose — so this is
   * an invented, documented code following the same pattern as
   * DOMAIN_HAS_PENDING_INVITES (ADR-006) rather than a generic 409/422 with
   * no machine-readable distinction.
   */
  async remove(organizationId: string, actorUserId: string, mailboxId: string): Promise<void> {
    await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      await this.findActiveByIdOrThrow(client, organizationId, mailboxId);

      // Live users only (fixed 2026-10-07): a deleted user keeps
      // primary_mailbox_id, and since "delete that user first" is exactly
      // what the error below tells the admin to do, counting deleted users
      // made their mailbox impossible to delete.
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM tenant.users WHERE primary_mailbox_id = $1 AND status <> 'deleted'",
        [mailboxId],
      );
      if (rows.length > 0) {
        throw new AppException(
          422,
          'MAILBOX_IS_PRIMARY',
          "This mailbox is a user's primary login mailbox — reassign or delete that user first.",
          { userId: rows[0].id },
        );
      }

      await client.query(`UPDATE tenant.mailboxes SET status = 'deleted' WHERE id = $1`, [mailboxId]);
      // Added 2026-10-07: a deleted mailbox's aliases would otherwise keep
      // their addresses taken forever (assertSlotAvailable checks every
      // alias row), and its access grants would keep showing on Group Detail.
      await client.query('DELETE FROM tenant.mailbox_aliases WHERE target_mailbox_id = $1', [mailboxId]);
      await client.query('DELETE FROM tenant.mailbox_access WHERE mailbox_id = $1', [mailboxId]);

      await this.auditLogs.record(client, organizationId, actorUserId, 'mailbox.deleted', {
        resourceType: 'mailbox',
        resourceId: mailboxId,
      });
    });
  }

  /** POST /mailboxes/{mailboxId}/aliases — "Add an alias local part" (api-contract.md §7). Owner/Admin only. */
  async createAlias(organizationId: string, actorUserId: string, mailboxId: string, dto: CreateAliasDto): Promise<AliasDto> {
    return this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const mailbox = await this.findActiveByIdOrThrow(client, organizationId, mailboxId);
      await this.assertSlotAvailable(client, mailbox.domain_id, dto.localPart);

      const { rows } = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO tenant.mailbox_aliases (organization_id, domain_id, alias_local_part, target_mailbox_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id, created_at`,
        [organizationId, mailbox.domain_id, dto.localPart, mailboxId],
      );

      await this.auditLogs.record(client, organizationId, actorUserId, 'mailbox.alias_added', {
        resourceType: 'mailbox',
        resourceId: mailboxId,
        metadata: { aliasId: rows[0].id, localPart: dto.localPart },
      });

      return {
        id: rows[0].id,
        localPart: dto.localPart,
        email: `${dto.localPart}@${mailbox.domain_name}`,
        createdAt: rows[0].created_at,
      };
    });
  }

  /**
   * DELETE /aliases/{aliasId} — top-level per api-contract.md §7 (not
   * nested under /mailboxes/{mailboxId} — an alias's own id is globally
   * unique within the org, so the caller doesn't need to know its target
   * mailbox to remove it). `mailbox_aliases` carries `organization_id`
   * directly (data-model.md), so this is a plain id+org filter, no join
   * needed to scope it correctly.
   */
  async removeAlias(organizationId: string, actorUserId: string, aliasId: string): Promise<void> {
    await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const { rows } = await client.query<{ target_mailbox_id: string; alias_local_part: string }>(
        'DELETE FROM tenant.mailbox_aliases WHERE id = $1 AND organization_id = $2 RETURNING target_mailbox_id, alias_local_part',
        [aliasId, organizationId],
      );
      if (rows.length === 0) {
        throw new AppException(404, 'NOT_FOUND', 'Alias not found.');
      }

      await this.auditLogs.record(client, organizationId, actorUserId, 'mailbox.alias_removed', {
        resourceType: 'mailbox',
        resourceId: rows[0].target_mailbox_id,
        metadata: { aliasId, localPart: rows[0].alias_local_part },
      });
    });
  }

  /** GET /mailboxes/{mailboxId}/access — "Owner/Admin, or manage grantee" (api-contract.md §7). */
  async listAccessGrants(organizationId: string, claims: AccessTokenClaims, mailboxId: string): Promise<AccessGrantDto[]> {
    return this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      await this.findActiveByIdOrThrow(client, organizationId, mailboxId);
      await this.assertManageAccess(client, mailboxId, claims);

      const { rows } = await client.query<{
        id: string;
        mailbox_id: string;
        user_id: string | null;
        group_id: string | null;
        access_level: AccessLevel;
        granted_at: Date;
        user_name: string | null;
        group_name: string | null;
      }>(
        `SELECT a.id, a.mailbox_id, a.user_id, a.group_id, a.access_level, a.granted_at,
                u.name AS user_name, g.name AS group_name
         FROM tenant.mailbox_access a
         LEFT JOIN tenant.users u ON u.id = a.user_id
         LEFT JOIN tenant.groups g ON g.id = a.group_id
         WHERE a.mailbox_id = $1
         ORDER BY a.granted_at`,
        [mailboxId],
      );
      return rows.map((r) => ({
        id: r.id,
        mailboxId: r.mailbox_id,
        userId: r.user_id,
        groupId: r.group_id,
        targetName: r.user_name ?? r.group_name ?? '',
        accessLevel: r.access_level,
        grantedAt: r.granted_at,
      }));
    });
  }

  /**
   * POST /mailboxes/{mailboxId}/access — "Grant read_only/send_as/manage to
   * a user OR a group" (api-contract.md §7), Owner/Admin only. The XOR
   * check can't be expressed at the DTO level (see CreateAccessGrantDto's
   * own doc comment), so it's enforced here, first, before opening a
   * transaction — a pure input-shape error shouldn't cost a DB round trip.
   */
  async createAccessGrant(organizationId: string, actorUserId: string, mailboxId: string, dto: CreateAccessGrantDto): Promise<AccessGrantDto> {
    if ((dto.userId == null) === (dto.groupId == null)) {
      throw new AppException(400, 'VALIDATION_ERROR', 'Provide exactly one of userId or groupId.', {
        field: 'userId/groupId',
      });
    }

    return this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      await this.findActiveByIdOrThrow(client, organizationId, mailboxId);

      let targetName: string;
      if (dto.userId) {
        const { rows } = await client.query<{ name: string }>(
          `SELECT name FROM tenant.users WHERE id = $1 AND status <> 'deleted'`,
          [dto.userId],
        );
        if (rows.length === 0) {
          throw new AppException(404, 'NOT_FOUND', 'User not found.');
        }
        targetName = rows[0].name;
      } else {
        const { rows } = await client.query<{ name: string }>('SELECT name FROM tenant.groups WHERE id = $1', [
          dto.groupId,
        ]);
        if (rows.length === 0) {
          throw new AppException(404, 'NOT_FOUND', 'Group not found.');
        }
        targetName = rows[0].name;
      }

      try {
        const { rows } = await client.query<{ id: string; granted_at: Date }>(
          `INSERT INTO tenant.mailbox_access (organization_id, mailbox_id, user_id, group_id, access_level)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, granted_at`,
          [organizationId, mailboxId, dto.userId ?? null, dto.groupId ?? null, dto.accessLevel],
        );

        await this.auditLogs.record(client, organizationId, actorUserId, 'mailbox.access_granted', {
          resourceType: 'mailbox',
          resourceId: mailboxId,
          metadata: { grantId: rows[0].id, userId: dto.userId ?? null, groupId: dto.groupId ?? null, accessLevel: dto.accessLevel },
        });

        return {
          id: rows[0].id,
          mailboxId,
          userId: dto.userId ?? null,
          groupId: dto.groupId ?? null,
          targetName,
          accessLevel: dto.accessLevel,
          grantedAt: rows[0].granted_at,
        };
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          // tenant.mailbox_access's own partial unique indexes
          // (mailbox_access_user_unique / _group_unique, migration 003).
          throw new AppException(409, 'ALREADY_GRANTED', 'This user or group already has access to this mailbox.');
        }
        throw err;
      }
    });
  }

  /** PATCH /mailboxes/{mailboxId}/access/{grantId} — "Change a grant's level," Owner/Admin only. */
  async updateAccessGrant(
    organizationId: string,
    actorUserId: string,
    mailboxId: string,
    grantId: string,
    dto: UpdateAccessGrantDto,
  ): Promise<AccessGrantDto> {
    return this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      await this.findActiveByIdOrThrow(client, organizationId, mailboxId);

      const { rows } = await client.query<{
        id: string;
        mailbox_id: string;
        user_id: string | null;
        group_id: string | null;
        access_level: AccessLevel;
        granted_at: Date;
      }>(
        `UPDATE tenant.mailbox_access SET access_level = $1
         WHERE id = $2 AND mailbox_id = $3
         RETURNING id, mailbox_id, user_id, group_id, access_level, granted_at`,
        [dto.accessLevel, grantId, mailboxId],
      );
      if (rows.length === 0) {
        throw new AppException(404, 'NOT_FOUND', 'Access grant not found.');
      }

      await this.auditLogs.record(client, organizationId, actorUserId, 'mailbox.access_updated', {
        resourceType: 'mailbox',
        resourceId: mailboxId,
        metadata: { grantId, accessLevel: dto.accessLevel },
      });

      const targetName = await this.resolveTargetName(client, rows[0].user_id, rows[0].group_id);
      return {
        id: rows[0].id,
        mailboxId: rows[0].mailbox_id,
        userId: rows[0].user_id,
        groupId: rows[0].group_id,
        targetName,
        accessLevel: rows[0].access_level,
        grantedAt: rows[0].granted_at,
      };
    });
  }

  /** DELETE /mailboxes/{mailboxId}/access/{grantId} — "Revoke a grant," Owner/Admin only. */
  async removeAccessGrant(organizationId: string, actorUserId: string, mailboxId: string, grantId: string): Promise<void> {
    await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      await this.findActiveByIdOrThrow(client, organizationId, mailboxId);
      const { rowCount } = await client.query('DELETE FROM tenant.mailbox_access WHERE id = $1 AND mailbox_id = $2', [
        grantId,
        mailboxId,
      ]);
      if (!rowCount) {
        throw new AppException(404, 'NOT_FOUND', 'Access grant not found.');
      }

      await this.auditLogs.record(client, organizationId, actorUserId, 'mailbox.access_revoked', {
        resourceType: 'mailbox',
        resourceId: mailboxId,
        metadata: { grantId },
      });
    });
  }

  // --- internal helpers -------------------------------------------------

  /** 404s, never a bare empty result (api-contract.md §0) — also treats a soft-deleted mailbox as gone, same as "doesn't exist." */
  private async findActiveByIdOrThrow(client: PoolClient, organizationId: string, mailboxId: string): Promise<MailboxJoinRow> {
    const { rows } = await client.query<MailboxJoinRow>(
      `${MAILBOX_SELECT} WHERE m.id = $1 AND m.organization_id = $2 AND m.status <> 'deleted'`,
      [mailboxId, organizationId],
    );
    if (rows.length === 0) {
      throw new AppException(404, 'NOT_FOUND', 'Mailbox not found.');
    }
    return rows[0];
  }

  private async listAliasesForMailbox(client: PoolClient, mailboxId: string): Promise<AliasDto[]> {
    const { rows } = await client.query<{ id: string; alias_local_part: string; domain_name: string; created_at: Date }>(
      `SELECT a.id, a.alias_local_part, d.domain_name, a.created_at
       FROM tenant.mailbox_aliases a
       JOIN control.domains d ON d.id = a.domain_id
       WHERE a.target_mailbox_id = $1
       ORDER BY a.created_at`,
      [mailboxId],
    );
    return rows.map((r) => ({
      id: r.id,
      localPart: r.alias_local_part,
      email: `${r.alias_local_part}@${r.domain_name}`,
      createdAt: r.created_at,
    }));
  }

  /**
   * "the caller is either the mailbox's user_id, or holds a mailbox_access
   * row for it (directly or through a group)" (data-model.md). Any access
   * level is sufficient for read access to the detail view — read_only
   * grantees can see it, just not send/manage; level-specific gating is
   * assertManageAccess's job, below.
   */
  private async assertReadAccess(client: PoolClient, mailbox: MailboxJoinRow, claims: AccessTokenClaims): Promise<void> {
    if (claims.role === 'owner' || claims.role === 'admin') {
      return;
    }
    if (mailbox.user_id === claims.userId) {
      return;
    }
    const hasGrant = await this.hasAnyAccessGrant(client, mailbox.id, claims.userId);
    if (!hasGrant) {
      throw new AppException(403, 'FORBIDDEN_MAILBOX_ACCESS', 'You do not have access to this mailbox.');
    }
  }

  private async hasAnyAccessGrant(client: PoolClient, mailboxId: string, userId: string): Promise<boolean> {
    const { rows } = await client.query(
      `SELECT 1 FROM tenant.mailbox_access
       WHERE mailbox_id = $1 AND (user_id = $2 OR group_id IN (SELECT group_id FROM tenant.group_members WHERE user_id = $2))
       LIMIT 1`,
      [mailboxId, userId],
    );
    return rows.length > 0;
  }

  /**
   * "GET /mailboxes/{mailboxId}/access | Owner/Admin, or manage grantee"
   * (api-contract.md §7) — stricter than assertReadAccess: being able to
   * view a mailbox's folder/messages (any grant level) is not the same as
   * being allowed to see or change who else has access to it.
   */
  private async assertManageAccess(client: PoolClient, mailboxId: string, claims: AccessTokenClaims): Promise<void> {
    if (claims.role === 'owner' || claims.role === 'admin') {
      return;
    }
    const { rows } = await client.query(
      `SELECT 1 FROM tenant.mailbox_access
       WHERE mailbox_id = $1 AND access_level = 'manage'
         AND (user_id = $2 OR group_id IN (SELECT group_id FROM tenant.group_members WHERE user_id = $2))
       LIMIT 1`,
      [mailboxId, claims.userId],
    );
    if (rows.length === 0) {
      throw new AppException(403, 'FORBIDDEN_MAILBOX_ACCESS', 'Manage-level access to this mailbox is required.');
    }
  }

  private async resolveTargetName(client: PoolClient, userId: string | null, groupId: string | null): Promise<string> {
    if (userId) {
      const { rows } = await client.query<{ name: string }>('SELECT name FROM tenant.users WHERE id = $1', [userId]);
      return rows[0]?.name ?? '';
    }
    if (groupId) {
      const { rows } = await client.query<{ name: string }>('SELECT name FROM tenant.groups WHERE id = $1', [groupId]);
      return rows[0]?.name ?? '';
    }
    return '';
  }

  private isUniqueViolation(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
  }

  private toListItemDto(row: MailboxJoinRow): MailboxListItemDto {
    return {
      id: row.id,
      domainId: row.domain_id,
      domainName: row.domain_name,
      localPart: row.local_part,
      email: `${row.local_part}@${row.domain_name}`,
      userId: row.user_id,
      userName: row.user_name,
      quotaBytes: Number(row.quota_bytes),
      status: row.status,
      createdAt: row.created_at,
    };
  }

  private toDetailDto(row: MailboxJoinRow, aliases: AliasDto[]): MailboxDetailDto {
    return { ...this.toListItemDto(row), aliases };
  }
}
