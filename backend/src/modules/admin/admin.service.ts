import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { DomainsService } from '../domains/domains.service';
import { AuditLogDto, AuditLogsService } from '../audit-logs/audit-logs.service';

/**
 * How many entries the Overview's "recent activity" tile shows. Not the
 * ordinary page-list limit (common/pagination/cursor.util.ts's
 * DEFAULT_PAGE_LIMIT=25, for GET /audit-logs's own full Log Viewer page) —
 * this is a dashboard tile, not a list screen, so it stays deliberately
 * small. No cursor is exposed here; anyone wanting to page further into
 * the log uses GET /audit-logs directly (api-contract.md §11), which this
 * tile is explicitly a preview of, not a replacement for.
 */
const RECENT_ACTIVITY_LIMIT = 10;

interface OverviewCountsRow {
  total_users: string;
  active_users: string;
  mailbox_count: string;
}

// `id`/`isPrimary` on domains and the full entry on recentActivity were
// added 2026-10-07 for the Overview screen (link each tile to its page,
// open an activity entry in the Log Viewer). Additive: every field
// api-contract.md §12 documents is still there, unchanged.
export interface AdminOverviewDomainDto {
  id: string;
  domainName: string;
  isPrimary: boolean;
  verificationStatus: 'pending' | 'verified' | 'failed';
  dkimStatus: 'not_generated' | 'pending' | 'verified';
}

/** Same shape as one GET /audit-logs entry. */
export type AdminOverviewActivityDto = AuditLogDto;

export interface AdminOverviewDto {
  totalUsers: number;
  activeUsers: number;
  mailboxCount: number;
  domains: AdminOverviewDomainDto[];
  recentActivity: AdminOverviewActivityDto[];
}

/**
 * Admin Console: Overview — claude/srs.md §7.11, architecture/api-contract.md
 * §12, implementation-plan Step 3.3. "Deliberately last" per the plan's own
 * note: every number here is an aggregate over data every prior module
 * (Users, Mailboxes, Domains, Audit Logs) already owns and exposes through
 * its own endpoint — this service adds no new data access pattern, it just
 * composes four cheap reads into one response so the Overview screen isn't
 * four-plus round trips on every load (api-contract.md §12's own stated
 * reason for the endpoint existing at all).
 *
 * `totalUsers`/`activeUsers`/`mailboxCount` are computed with one direct
 * COUNT query rather than by fetching UsersService.list()/
 * MailboxesService.list()'s full row sets just to take their length — those
 * two methods exist to serve their own list screens (and, for mailboxes,
 * carry member-scoping logic this Owner/Admin-only endpoint doesn't need),
 * not to back a dashboard tile. `domains` and `recentActivity` DO reuse
 * DomainsService.list()/AuditLogsService.list() as-is: those already return
 * exactly the shape (or a superset of it) this tile needs, so recomputing
 * dkimStatus derivation or audit-log filtering here would just be a second,
 * divergence-prone copy of logic that already lives in one place.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly db: DatabaseService,
    private readonly domains: DomainsService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /** GET /admin/overview — Owner/Admin only, enforced by the controller's @Roles(). */
  async getOverview(organizationId: string): Promise<AdminOverviewDto> {
    const counts = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const { rows } = await client.query<OverviewCountsRow>(
        `SELECT
           (SELECT COUNT(*) FROM tenant.users WHERE status <> 'deleted') AS total_users,
           (SELECT COUNT(*) FROM tenant.users WHERE status = 'active') AS active_users,
           (SELECT COUNT(*) FROM tenant.mailboxes WHERE status <> 'deleted') AS mailbox_count`,
      );
      return rows[0];
    });

    // Independent reads under the same organization scope — no ordering
    // dependency between them, so run concurrently rather than serially.
    const [domainRows, activityPage] = await Promise.all([
      this.domains.list(organizationId),
      this.auditLogs.list(organizationId, { limit: String(RECENT_ACTIVITY_LIMIT) }),
    ]);

    return {
      totalUsers: parseInt(counts.total_users, 10),
      activeUsers: parseInt(counts.active_users, 10),
      mailboxCount: parseInt(counts.mailbox_count, 10),
      domains: domainRows.map((d) => ({
        id: d.id,
        domainName: d.domainName,
        isPrimary: d.isPrimary,
        verificationStatus: d.verificationStatus,
        dkimStatus: d.dkimStatus,
      })),
      recentActivity: activityPage.data,
    };
  }
}
