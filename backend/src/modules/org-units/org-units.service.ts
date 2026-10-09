import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app-exception';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CreateOrgUnitDto } from './dto/create-org-unit.dto';
import { UpdateOrgUnitDto } from './dto/update-org-unit.dto';

interface OrgUnitRow {
  id: string;
  organization_id: string;
  parent_org_unit_id: string | null;
  name: string;
  created_at: Date;
  updated_at: Date;
}

export interface OrgUnitDto {
  id: string;
  organizationId: string;
  parentOrgUnitId: string | null;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Org Units — architecture/api-contract.md §5, implementation-plan Step 1.5.
 * The root unit itself is created by OrganizationsService.bootstrap (Step
 * 1.3) — this service only ever manages non-root units on top of it.
 */
@Injectable()
export class OrgUnitsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /**
   * GET /org-units — "the org's unit tree." Returned as a flat list, parent-
   * before-child (a recursive CTE walking down from the root), rather than a
   * nested JSON tree: the contract doesn't specify a shape, and a flat list
   * with parentOrgUnitId is what every tree-view component (and Flow 10's
   * "new unit appears nested under Engineering") actually needs to build the
   * UI from, with no fixed nesting depth to design a schema for. No `data`
   * pagination meta, same reasoning as GET /me/sessions (auth.controller.ts):
   * this endpoint has no `?cursor=` in the contract, and in practice one
   * organization's unit count is small enough that cursor pagination over it
   * would be misleading overhead, not a real list-at-scale concern.
   */
  async listTree(organizationId: string): Promise<OrgUnitDto[]> {
    const orgUnitRows: OrgUnitRow[] = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const queryResult = await client.query<OrgUnitRow>(
        `WITH RECURSIVE tree AS (
           SELECT id, organization_id, parent_org_unit_id, name, created_at, updated_at,
                  ARRAY[name] AS sort_path
           FROM tenant.org_units
           WHERE parent_org_unit_id IS NULL
           UNION ALL
           SELECT ou.id, ou.organization_id, ou.parent_org_unit_id, ou.name, ou.created_at, ou.updated_at,
                  tree.sort_path || ou.name
           FROM tenant.org_units ou
           JOIN tree ON ou.parent_org_unit_id = tree.id
         )
         SELECT id, organization_id, parent_org_unit_id, name, created_at, updated_at
         FROM tree
         ORDER BY sort_path`,
      );
      return queryResult.rows;
    });
    return orgUnitRows.map((row) => this.toDto(row));
  }

  /**
   * POST /org-units. `parentOrgUnitId` is required by CreateOrgUnitDto's
   * @IsUUID() (no @IsOptional()) — api-contract.md §5: "Omitting
   * parentOrgUnitId is rejected (400) ... there's no endpoint to create a
   * second root." class-validator's global ValidationPipe (main.ts) rejects
   * a missing/malformed one before this method ever runs.
   */
  async create(organizationId: string, actorUserId: string, dto: CreateOrgUnitDto): Promise<OrgUnitDto> {
    const row = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      await this.findByIdOrThrow(client, dto.parentOrgUnitId);

      const { rows } = await client.query<OrgUnitRow>(
        `INSERT INTO tenant.org_units (organization_id, parent_org_unit_id, name)
         VALUES ($1, $2, $3)
         RETURNING id, organization_id, parent_org_unit_id, name, created_at, updated_at`,
        [organizationId, dto.parentOrgUnitId, dto.name],
      );
      const row = rows[0];

      // Step 3.2: claude/srs.md §7.10 MVP event "Organizational Unit /
      // Group changes."
      await this.auditLogs.record(client, organizationId, actorUserId, 'org_unit.created', {
        resourceType: 'org_unit',
        resourceId: row.id,
        metadata: { name: row.name, parentOrgUnitId: row.parent_org_unit_id },
      });

      return row;
    });
    return this.toDto(row);
  }

  /**
   * PATCH /org-units/{orgUnitId} — rename and/or reparent. Two invariants
   * not spelled out in api-contract.md/data-model.md but necessary to keep
   * "org units are a tree with exactly one root" true, found while building
   * this method (not a hypothetical — an unguarded reparent genuinely allows
   * both of the following):
   *
   *  1. The root unit's own parent must never become non-null — there is no
   *     endpoint to create a second root (§5), and reparenting the existing
   *     root away from NULL would either strand it as a non-root unit with
   *     no parent-chain back to a real root, or (combined with #2) just move
   *     the "root" label onto whichever unit it got attached under.
   *  2. A reparent must never introduce a cycle — moving a unit to be a
   *     descendant of itself (directly or transitively) would silently turn
   *     the tree into a cycle, which breaks every recursive-CTE read above
   *     (infinite loop) and every tree-view the frontend renders from it.
   */
  async update(organizationId: string, actorUserId: string, orgUnitId: string, dto: UpdateOrgUnitDto): Promise<OrgUnitDto> {
    const row = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const current = await this.findByIdOrThrow(client, orgUnitId);

      if (dto.parentOrgUnitId !== undefined) {
        if (current.parent_org_unit_id === null) {
          throw new AppException(422, 'ORG_UNIT_IS_ROOT', 'The root org unit cannot be reparented.');
        }
        if (dto.parentOrgUnitId === orgUnitId) {
          throw new AppException(422, 'ORG_UNIT_CYCLE', 'An org unit cannot be its own parent.');
        }
        await this.findByIdOrThrow(client, dto.parentOrgUnitId);
        await this.assertNoCycle(client, orgUnitId, dto.parentOrgUnitId);
      }

      const { rows } = await client.query<OrgUnitRow>(
        `UPDATE tenant.org_units
         SET name = COALESCE($1, name),
             parent_org_unit_id = COALESCE($2, parent_org_unit_id),
             updated_at = now()
         WHERE id = $3
         RETURNING id, organization_id, parent_org_unit_id, name, created_at, updated_at`,
        [dto.name ?? null, dto.parentOrgUnitId ?? null, orgUnitId],
      );
      const row = rows[0];

      await this.auditLogs.record(client, organizationId, actorUserId, 'org_unit.updated', {
        resourceType: 'org_unit',
        resourceId: row.id,
        metadata: { name: dto.name, parentOrgUnitId: dto.parentOrgUnitId },
      });

      return row;
    });
    return this.toDto(row);
  }

  /**
   * DELETE /org-units/{orgUnitId}. api-contract.md §5: blocked (422
   * ORG_UNIT_NOT_EMPTY) if it still has members or child units. The root-unit
   * guard below is this service's own addition: screen-flow-inventory.md
   * §2.4 says the frontend hides the delete action on the root unit
   * entirely, but per SRS §8.1 ("defense in depth — the backend re-enforces
   * every rule regardless of what the frontend hides"), a backend that only
   * relied on the UI hiding a button isn't actually enforcing anything.
   */
  async remove(organizationId: string, actorUserId: string, orgUnitId: string): Promise<void> {
    await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const current = await this.findByIdOrThrow(client, orgUnitId);

      if (current.parent_org_unit_id === null) {
        throw new AppException(422, 'ORG_UNIT_IS_ROOT', 'The root org unit cannot be deleted.');
      }

      // Sequential, not Promise.all: a pg client runs one query at a time anyway.
      // Members are live (non-deleted) users only — a soft-deleted account is
      // invisible everywhere else and can't be moved (PATCH on a deleted user
      // 404s), so counting it would make the unit undeletable forever.
      const { rows: memberRows } = await client.query<{ id: string }>(
        "SELECT id FROM tenant.users WHERE org_unit_id = $1 AND status <> 'deleted'",
        [orgUnitId],
      );
      const { rows: childRows } = await client.query<{ id: string }>(
        'SELECT id FROM tenant.org_units WHERE parent_org_unit_id = $1',
        [orgUnitId],
      );
      // Pending invites that would place someone in this unit on acceptance.
      // tenant.invites.org_unit_id has no ON DELETE action, so these used to
      // surface as a raw foreign-key 500 (fixed 2026-10-07).
      const { rows: inviteRows } = await client.query<{ id: string }>(
        'SELECT id FROM tenant.invites WHERE org_unit_id = $1 AND accepted_at IS NULL',
        [orgUnitId],
      );

      if (memberRows.length > 0 || childRows.length > 0 || inviteRows.length > 0) {
        throw new AppException(
          422,
          'ORG_UNIT_NOT_EMPTY',
          'This org unit still has members, child units or pending invites — reassign or revoke them first.',
          {
            memberUserIds: memberRows.map((r) => r.id),
            childOrgUnitIds: childRows.map((r) => r.id),
            pendingInviteIds: inviteRows.map((r) => r.id),
          },
        );
      }

      // Everything still pointing here is history the admin can't see or act
      // on: soft-deleted accounts move up to the parent unit, and accepted
      // invites drop their (no longer meaningful) target unit. Without this,
      // the same FKs that blocked pending invites made the DELETE fail.
      await client.query(
        "UPDATE tenant.users SET org_unit_id = $1 WHERE org_unit_id = $2 AND status = 'deleted'",
        [current.parent_org_unit_id, orgUnitId],
      );
      await client.query('UPDATE tenant.invites SET org_unit_id = NULL WHERE org_unit_id = $1', [orgUnitId]);

      await client.query('DELETE FROM tenant.org_units WHERE id = $1', [orgUnitId]);

      await this.auditLogs.record(client, organizationId, actorUserId, 'org_unit.deleted', {
        resourceType: 'org_unit',
        resourceId: orgUnitId,
        metadata: { name: current.name },
      });
    });
  }

  /** Walks candidateParentId up its parent chain; throws if it ever reaches unitId. */
  private async assertNoCycle(client: PoolClient, unitId: string, candidateParentId: string): Promise<void> {
    let current: string | null = candidateParentId;
    const seen = new Set<string>();
    while (current !== null) {
      const currentId: string = current;
      if (currentId === unitId) {
        throw new AppException(
          422,
          'ORG_UNIT_CYCLE',
          'That parent is a descendant of this unit — cannot create a cycle.',
        );
      }
      if (seen.has(currentId)) break; // defensive only — a valid tree never loops
      seen.add(currentId);
      const parentResult: { rows: { parent_org_unit_id: string | null }[] } = await client.query<{
        parent_org_unit_id: string | null;
      }>('SELECT parent_org_unit_id FROM tenant.org_units WHERE id = $1', [currentId]);
      current = parentResult.rows[0]?.parent_org_unit_id ?? null;
    }
  }

  /** 404s, never a bare empty result — a cross-org id is indistinguishable from a missing one (api-contract.md §0). */
  private async findByIdOrThrow(client: PoolClient, id: string): Promise<OrgUnitRow> {
    const { rows } = await client.query<OrgUnitRow>(
      'SELECT id, organization_id, parent_org_unit_id, name, created_at, updated_at FROM tenant.org_units WHERE id = $1',
      [id],
    );
    if (rows.length === 0) {
      throw new AppException(404, 'NOT_FOUND', 'Org unit not found.');
    }
    return rows[0];
  }

  private toDto(row: OrgUnitRow): OrgUnitDto {
    return {
      id: row.id,
      organizationId: row.organization_id,
      parentOrgUnitId: row.parent_org_unit_id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
