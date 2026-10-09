import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app-exception';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CreateGroupDto } from './dto/create-group.dto';
import { UpdateGroupDto } from './dto/update-group.dto';

interface GroupRow {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  created_at: Date;
}

export interface GroupListItemDto {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  createdAt: Date;
}

export interface GroupMemberDto {
  userId: string;
  name: string;
  email: string;
  addedAt: Date;
}

export interface GroupMailboxAccessDto {
  grantId: string;
  mailboxId: string;
  email: string;
  accessLevel: 'read_only' | 'send_as' | 'manage';
}

export interface GroupDetailDto {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  members: GroupMemberDto[];
  /** Mailboxes this group grants access to (reverse of mailbox_access). */
  mailboxAccess: GroupMailboxAccessDto[];
}

/**
 * Groups — architecture/api-contract.md §5, implementation-plan Step 1.5.
 * Flat (no nesting — data-model.md is explicit this is what keeps Groups
 * distinct from Org Units), multi-membership. Deleting a group cascades to
 * both tenant.group_members and tenant.mailbox_access via the FKs' own
 * ON DELETE CASCADE (migration 003) — api-contract.md §5's "its
 * mailbox_access grants, if any, are removed too" needs no extra app code.
 */
@Injectable()
export class GroupsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /**
   * GET /groups. `memberCount` isn't specified by api-contract.md's response
   * shape (left undefined there), but screen-flow-inventory.md's Group List
   * screen is explicitly a list to scan before drilling into one — a count
   * per row is the obvious thing such a list needs and costs one extra
   * subquery; no `data`-pagination meta, same reasoning as GET /org-units
   * (auth.controller.ts's /me/sessions precedent: no `?cursor=` in the
   * contract for this endpoint, so no meta block implying support that
   * doesn't exist).
   */
  async list(organizationId: string): Promise<GroupListItemDto[]> {
    const rows = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const { rows } = await client.query<GroupRow & { member_count: string }>(
        `SELECT g.id, g.organization_id, g.name, g.description, g.created_at,
                COUNT(gm.user_id) AS member_count
         FROM tenant.groups g
         LEFT JOIN tenant.group_members gm ON gm.group_id = g.id
           AND EXISTS (SELECT 1 FROM tenant.users u WHERE u.id = gm.user_id AND u.status <> 'deleted')
         GROUP BY g.id
         ORDER BY g.name`,
      );
      return rows;
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      memberCount: parseInt(row.member_count, 10),
      createdAt: row.created_at,
    }));
  }

  async create(organizationId: string, actorUserId: string, dto: CreateGroupDto): Promise<GroupListItemDto> {
    const row = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      await this.assertNameAvailable(client, dto.name);

      const { rows } = await client.query<GroupRow>(
        `INSERT INTO tenant.groups (organization_id, name, description)
         VALUES ($1, $2, $3)
         RETURNING id, organization_id, name, description, created_at`,
        [organizationId, dto.name, dto.description ?? null],
      );
      const row = rows[0];

      // Step 3.2: claude/srs.md §7.10 MVP event "Organizational Unit /
      // Group changes."
      await this.auditLogs.record(client, organizationId, actorUserId, 'group.created', {
        resourceType: 'group',
        resourceId: row.id,
        metadata: { name: row.name },
      });

      return row;
    });
    return { id: row.id, name: row.name, description: row.description, memberCount: 0, createdAt: row.created_at };
  }

  /** GET /groups/{groupId} — "group detail + member list" (api-contract.md §5). */
  async getDetail(organizationId: string, groupId: string): Promise<GroupDetailDto> {
    return this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const group = await this.findByIdOrThrow(client, groupId);

      const { rows: memberRows } = await client.query<{
        user_id: string;
        name: string;
        email: string;
        added_at: Date;
      }>(
        `SELECT u.id AS user_id, u.name, u.email, gm.added_at
         FROM tenant.group_members gm
         JOIN tenant.users u ON u.id = gm.user_id
         WHERE gm.group_id = $1 AND u.status <> 'deleted'
         ORDER BY gm.added_at`,
        [groupId],
      );

      // screen-flow-inventory.md §2.4: Group Detail "shows which mailboxes
      // this group currently has access to (reverse lookup against
      // mailbox_access), so deleting a group makes its access consequences
      // visible before confirming." Added 2026-10-07 for the Group Detail screen.
      const { rows: accessRows } = await client.query<{
        grant_id: string;
        mailbox_id: string;
        local_part: string;
        domain_name: string;
        access_level: 'read_only' | 'send_as' | 'manage';
      }>(
        `SELECT ma.id AS grant_id, m.id AS mailbox_id, m.local_part, d.domain_name, ma.access_level
         FROM tenant.mailbox_access ma
         JOIN tenant.mailboxes m ON m.id = ma.mailbox_id AND m.status <> 'deleted'
         JOIN control.domains d ON d.id = m.domain_id
         WHERE ma.group_id = $1
         ORDER BY d.domain_name, m.local_part`,
        [groupId],
      );

      return {
        id: group.id,
        name: group.name,
        description: group.description,
        createdAt: group.created_at,
        members: memberRows.map((r) => ({ userId: r.user_id, name: r.name, email: r.email, addedAt: r.added_at })),
        mailboxAccess: accessRows.map((r) => ({
          grantId: r.grant_id,
          mailboxId: r.mailbox_id,
          email: `${r.local_part}@${r.domain_name}`,
          accessLevel: r.access_level,
        })),
      };
    });
  }

  async update(organizationId: string, actorUserId: string, groupId: string, dto: UpdateGroupDto): Promise<GroupListItemDto> {
    const row = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      await this.findByIdOrThrow(client, groupId);

      if (dto.name !== undefined) {
        await this.assertNameAvailable(client, dto.name, groupId);
      }

      const { rows } = await client.query<GroupRow & { member_count: string }>(
        `UPDATE tenant.groups g
         SET name = COALESCE($1, name),
             description = CASE WHEN $2::boolean THEN $3 ELSE description END
         WHERE id = $4
         RETURNING id, organization_id, name, description, created_at,
           (SELECT COUNT(*) FROM tenant.group_members gm JOIN tenant.users u ON u.id = gm.user_id
            WHERE gm.group_id = g.id AND u.status <> 'deleted') AS member_count`,
        [dto.name ?? null, dto.description !== undefined, dto.description ?? null, groupId],
      );
      const row = rows[0];

      await this.auditLogs.record(client, organizationId, actorUserId, 'group.updated', {
        resourceType: 'group',
        resourceId: groupId,
        metadata: { name: dto.name, description: dto.description },
      });

      return row;
    });
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      memberCount: parseInt(row.member_count, 10),
      createdAt: row.created_at,
    };
  }

  /** DELETE /groups/{groupId} — group_members and mailbox_access cascade via FK, see class doc comment. */
  async remove(organizationId: string, actorUserId: string, groupId: string): Promise<void> {
    await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const current = await this.findByIdOrThrow(client, groupId);
      await client.query('DELETE FROM tenant.groups WHERE id = $1', [groupId]);

      await this.auditLogs.record(client, organizationId, actorUserId, 'group.deleted', {
        resourceType: 'group',
        resourceId: groupId,
        metadata: { name: current.name },
      });
    });
  }

  async addMember(organizationId: string, actorUserId: string, groupId: string, userId: string): Promise<void> {
    await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      await this.findByIdOrThrow(client, groupId);

      // A deleted account can't be added (it would only grant a dead login
      // mailbox access through the group).
      const { rows: userRows } = await client.query<{ id: string }>(
        "SELECT id FROM tenant.users WHERE id = $1 AND status <> 'deleted'",
        [userId],
      );
      if (userRows.length === 0) {
        throw new AppException(404, 'NOT_FOUND', 'User not found.');
      }

      const { rows: existing } = await client.query<{ user_id: string }>(
        'SELECT user_id FROM tenant.group_members WHERE group_id = $1 AND user_id = $2',
        [groupId, userId],
      );
      if (existing.length > 0) {
        throw new AppException(409, 'ALREADY_GROUP_MEMBER', 'This user is already a member of this group.');
      }

      await client.query('INSERT INTO tenant.group_members (group_id, user_id) VALUES ($1, $2)', [groupId, userId]);

      await this.auditLogs.record(client, organizationId, actorUserId, 'group.member_added', {
        resourceType: 'group',
        resourceId: groupId,
        metadata: { userId },
      });
    });
  }

  /**
   * DELETE /groups/{groupId}/members/{userId}. Idempotent on the membership
   * itself (removing someone who isn't a member is a no-op, not an error —
   * the end state the caller wants is already true) — the group must exist,
   * though, or this 404s same as every other sub-resource here.
   */
  async removeMember(organizationId: string, actorUserId: string, groupId: string, userId: string): Promise<void> {
    await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      await this.findByIdOrThrow(client, groupId);
      await client.query('DELETE FROM tenant.group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);

      await this.auditLogs.record(client, organizationId, actorUserId, 'group.member_removed', {
        resourceType: 'group',
        resourceId: groupId,
        metadata: { userId },
      });
    });
  }

  private async assertNameAvailable(client: PoolClient, name: string, excludingGroupId?: string): Promise<void> {
    const { rows } = await client.query<{ id: string }>(
      excludingGroupId
        ? 'SELECT id FROM tenant.groups WHERE name = $1 AND id != $2'
        : 'SELECT id FROM tenant.groups WHERE name = $1',
      excludingGroupId ? [name, excludingGroupId] : [name],
    );
    if (rows.length > 0) {
      throw new AppException(409, 'GROUP_NAME_TAKEN', 'A group with this name already exists.', { field: 'name' });
    }
  }

  private async findByIdOrThrow(client: PoolClient, groupId: string): Promise<GroupRow> {
    const { rows } = await client.query<GroupRow>(
      'SELECT id, organization_id, name, description, created_at FROM tenant.groups WHERE id = $1',
      [groupId],
    );
    if (rows.length === 0) {
      throw new AppException(404, 'NOT_FOUND', 'Group not found.');
    }
    return rows[0];
  }
}
