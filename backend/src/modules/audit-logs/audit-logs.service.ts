import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app-exception';
import { buildPage, decodeCursor, parseLimit } from '../../common/pagination/cursor.util';

/**
 * Tenant-scoped action taxonomy — claude/srs.md §7.10's literal "MVP events"
 * list ("Login, Logout, User creation, User deletion, Role changes,
 * Organizational Unit / Group changes, Domain changes, Mailbox changes,
 * Organization settings changes"), plus planning/business-rules-and-
 * defaults.md's explicit audit-logging callouts for password resets and
 * admin-triggered reissues. Each dotted prefix is the resource family
 * (matches `resource_type`); deliberately does NOT include an MFA
 * enable/disable action — SRS's literal MVP event list has no MFA entry
 * (that's a Notifications-only "security alert" per §7.9, not named here),
 * so adding one would be scope beyond what's documented, the same
 * discipline NotificationsService's own doc comment applies to its
 * `NotificationType` union.
 *
 * "Organization settings changes" is in the SRS list but has NO
 * corresponding endpoint anywhere in this codebase yet — grep confirms
 * organizations.service.ts only has `bootstrap()` (POST /organizations);
 * there's no `PATCH /organization` to instrument. Documented as a known gap
 * in claude/build-progress.md rather than faked here with a dead action no
 * code ever emits.
 */
export type AuditAction =
  | 'user.login'
  | 'user.logout'
  | 'user.created'
  | 'user.deleted'
  | 'user.role_changed'
  | 'user.status_changed'
  | 'user.ownership_transferred'
  | 'user.password_reset'
  | 'user.password_reissued'
  // Added 2026-10-07 with PATCH /me/password — the self-service sibling of
  // the two password events above.
  | 'user.password_changed'
  | 'org_unit.created'
  | 'org_unit.updated'
  | 'org_unit.deleted'
  | 'group.created'
  | 'group.updated'
  | 'group.deleted'
  | 'group.member_added'
  | 'group.member_removed'
  | 'domain.added'
  | 'domain.verified'
  | 'domain.removed'
  | 'domain.primary_set'
  | 'mailbox.created'
  | 'mailbox.updated'
  | 'mailbox.deleted'
  | 'mailbox.alias_added'
  | 'mailbox.alias_removed'
  | 'mailbox.access_granted'
  | 'mailbox.access_updated'
  | 'mailbox.access_revoked'
  // Added 2026-10-07 with PATCH /organization — closes the "organization
  // settings changes" item from SRS §7.10's MVP list (ADR-009's open gap).
  | 'organization.updated';

/**
 * Control-plane action taxonomy — claude/srs.md §7.10: "Platform-level
 * events (e.g., organization creation, domain verification outcomes) are
 * indexed in the control-plane database." Exactly these two sources write
 * to control.audit_logs in this build; see each call site's own doc
 * comment (OrganizationsService.bootstrap, DomainsService.verify).
 */
export type PlatformAuditAction = 'organization.created' | 'domain.verification_outcome';

interface AuditLogRow {
  id: string;
  organization_id: string;
  actor_user_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  ip_address: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface AuditLogDto {
  id: string;
  actorUserId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  ipAddress: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface RecordOpts {
  resourceType?: string;
  resourceId?: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditLogListFilters {
  limit?: string;
  cursor?: string;
  actorUserId?: string;
  action?: string;
  resourceType?: string;
  from?: string;
  to?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Audit Logs — claude/srs.md §7.10, architecture/api-contract.md §11,
 * implementation-plan Step 3.2. As planning/implementation-plan.md itself
 * flags, "what's actually left for this step is standing up the central
 * audit_logs storage, the query API, and the Log Viewer UI — not writing
 * instrumentation for the first time"; claude/build-progress.md's "Known
 * gaps" section (recorded across Phase 1 and Phase 2) is the honest
 * admission that instrumentation was in fact never wired in as each prior
 * module was built, so this step both stands up this service AND retrofits
 * every call site — org-units, groups, domains, mailboxes, users, auth,
 * organizations — in one pass. See architecture/decisions.md for the new
 * ADR this retrofit earned.
 *
 * `record()` and `recordPlatform()` both follow the composable-transaction
 * pattern established by MailboxesService.assertSlotAvailable/createMailbox
 * and reused by NotificationsService.create/notifyAdmins: they take an
 * already-open `client` rather than opening their own transaction, so an
 * audit entry commits atomically with the action it describes — if the
 * surrounding transaction rolls back, the audit trail never shows an action
 * that didn't actually happen.
 */
@Injectable()
export class AuditLogsService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Tenant-plane write — architecture/data-model.md's `tenant.audit_logs`
   * (RLS-scoped, migration 004). `actorUserId` is nullable on the table
   * itself, but every call site in this codebase always has one by the time
   * it calls this: even the one fully public, unauthenticated path that
   * creates an audit-worthy event (accept-invite) has a concrete actor —
   * the newly created user themselves, completing their own invite. `null`
   * is accepted here only for schema-completeness, not because any current
   * caller passes it.
   */
  async record(
    client: PoolClient,
    organizationId: string,
    actorUserId: string | null,
    action: AuditAction,
    opts: RecordOpts = {},
  ): Promise<void> {
    await client.query(
      `INSERT INTO tenant.audit_logs
         (organization_id, actor_user_id, action, resource_type, resource_id, ip_address, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        organizationId,
        actorUserId,
        action,
        opts.resourceType ?? null,
        opts.resourceId ?? null,
        opts.ipAddress ?? null,
        JSON.stringify(opts.metadata ?? {}),
      ],
    );
  }

  /**
   * Control-plane write — `control.audit_logs` (no RLS; `actor_type` CHECK
   * IN ('platform_admin','system'), no `actor_user_id` column at all — see
   * data-model.md). This build has no platform-admin-accounts module (SRS
   * §8.2 lists "platform admin accounts" as control-plane data, but nothing
   * creates one), so every call site in this codebase passes `'system'` —
   * there is currently no code path that could legitimately pass
   * `'platform_admin'`. Takes a `client` for the same atomicity reason as
   * `record()`: both of this service's current callers (OrganizationsService
   * .bootstrap, DomainsService.verify) already have a transaction open, and
   * control.audit_logs having no RLS doesn't change that — it's still just
   * another table write that should commit or roll back with the action it
   * describes.
   */
  async recordPlatform(
    client: PoolClient,
    actorType: 'platform_admin' | 'system',
    action: PlatformAuditAction,
    organizationId: string | null,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await client.query(
      `INSERT INTO control.audit_logs (organization_id, actor_type, action, metadata)
       VALUES ($1, $2, $3, $4)`,
      [organizationId, actorType, action, JSON.stringify(metadata)],
    );
  }

  /**
   * GET /audit-logs — api-contract.md §11: "Paginated; filters:
   * ?actorUserId=, ?action=, ?resourceType=, ?from=, ?to=." Owner/Admin
   * only, enforced by the controller's @Roles(). Cursor-paginated the same
   * way Notifications (Step 3.1) is — an append-only, unbounded-growth log
   * is exactly the case common/pagination/cursor.util.ts's doc comment
   * calls out. `actorUserId` is validated as a UUID shape (not just handed
   * to Postgres raw) so a garbled filter value 400s cleanly instead of
   * surfacing as a raw invalid-input-syntax 500 — the same discipline
   * cursor.util.ts's own decodeCursor applies to the cursor parameter.
   */
  async list(
    organizationId: string,
    filters: AuditLogListFilters,
  ): Promise<{ data: AuditLogDto[]; meta: { nextCursor: string | null; hasMore: boolean } }> {
    const limit = parseLimit(filters.limit);
    const cursorId = decodeCursor(filters.cursor);

    if (filters.actorUserId !== undefined && !UUID_RE.test(filters.actorUserId)) {
      throw new AppException(400, 'VALIDATION_ERROR', 'actorUserId must be a valid UUID.');
    }

    const fromDate = this.parseDateFilter(filters.from, 'from');
    const toDate = this.parseDateFilter(filters.to, 'to');

    const rows = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const { rows } = await client.query<AuditLogRow>(
        `SELECT id, organization_id, actor_user_id, action, resource_type, resource_id, ip_address, metadata, created_at
         FROM tenant.audit_logs
         WHERE ($1::uuid IS NULL OR id < $1)
           AND ($2::uuid IS NULL OR actor_user_id = $2)
           AND ($3::text IS NULL OR action = $3)
           AND ($4::text IS NULL OR resource_type = $4)
           AND ($5::timestamptz IS NULL OR created_at >= $5)
           AND ($6::timestamptz IS NULL OR created_at <= $6)
         ORDER BY id DESC
         LIMIT $7`,
        [
          cursorId,
          filters.actorUserId ?? null,
          filters.action ?? null,
          filters.resourceType ?? null,
          fromDate,
          toDate,
          limit + 1,
        ],
      );
      return rows;
    });

    return buildPage(rows, limit, (row) => this.toDto(row));
  }

  /** GET /audit-logs/{id} — "One entry," Owner/Admin only. RLS scopes this to the caller's org — a cross-org id 404s, never leaks existence. */
  async getById(organizationId: string, id: string): Promise<AuditLogDto> {
    const row = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const { rows } = await client.query<AuditLogRow>(
        `SELECT id, organization_id, actor_user_id, action, resource_type, resource_id, ip_address, metadata, created_at
         FROM tenant.audit_logs WHERE id = $1`,
        [id],
      );
      if (rows.length === 0) {
        throw new AppException(404, 'NOT_FOUND', 'Audit log entry not found.');
      }
      return rows[0];
    });
    return this.toDto(row);
  }

  private parseDateFilter(raw: string | undefined, field: 'from' | 'to'): Date | null {
    if (raw === undefined) {
      return null;
    }
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      throw new AppException(400, 'VALIDATION_ERROR', `${field} must be a valid ISO 8601 date.`);
    }
    return date;
  }

  private toDto(row: AuditLogRow): AuditLogDto {
    return {
      id: row.id,
      actorUserId: row.actor_user_id,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      ipAddress: row.ip_address,
      metadata: row.metadata,
      createdAt: row.created_at,
    };
  }
}
