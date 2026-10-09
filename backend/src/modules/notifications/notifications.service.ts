import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app-exception';
import { buildPage, decodeCursor, Page, parseLimit } from '../../common/pagination/cursor.util';

/**
 * Every notification this build emits — exactly the SRS §7.9 events that
 * have a real code path behind them, and nothing speculative:
 *
 *  - domain_verified     DomainsService.verify(), on the real transition only (all Owner/Admins)
 *  - user_joined         UsersService.acceptInvite()/createDirect() (all Owner/Admins)
 *  - password_reissued   UsersService.reissuePassword() (the affected user)
 *  - password_reset      AuthService.confirmPasswordReset() (the affected user)
 *  - mfa_disabled        AuthService.disableMfa() (the affected user)
 *  - password_changed    AuthService.changePassword() (the affected user) — added 2026-10-07
 *                        alongside PATCH /me/password, as the same kind of
 *                        "your credentials changed" security alert as the
 *                        two above.
 *
 * Deliberately absent: SRS §7.9's "storage limit reached" (no real mailbox
 * usage data exists until Dovecot does — Step 2.1/2.4) and "subscription
 * event" (billing paused, ADR-003).
 */
export type NotificationType =
  | 'domain_verified'
  | 'user_joined'
  | 'password_reissued'
  | 'password_reset'
  | 'mfa_disabled'
  | 'password_changed';

interface NotificationRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  read_at: Date | null;
  created_at: Date;
}

export interface NotificationDto {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  readAt: Date | null;
  createdAt: Date;
}

export interface NotificationListFilters {
  limit?: string;
  cursor?: string;
  unreadOnly?: string;
}

/**
 * Notifications — claude/srs.md §7.9, architecture/api-contract.md §10,
 * implementation-plan Step 3.1. In-app only; invite and password-reset
 * links are the documented email exceptions and go through MailerService,
 * never this table.
 *
 * `create()`/`notifyAdmins()` take an already-open `client` (the same
 * composable-transaction pattern as MailboxesService.assertSlotAvailable and
 * AuditLogsService.record): a notification commits or rolls back with the
 * action it describes, so nobody is ever told about something that didn't
 * happen. Callers have already set the tenant context on that client.
 *
 * Reads are own-only: every query filters on the caller's user id on top of
 * RLS's organization scoping, and a notification belonging to someone else
 * in the same org 404s exactly like one in another org.
 *
 * (Reconstructed 2026-10-07: the original Step 3.1 files never reached the
 * Mac copy of this repo; rebuilt against the existing call sites and the
 * Step 3.1 notes in claude/build-progress.md.)
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly db: DatabaseService) {}

  /** One notification for one user. Never put a secret (temp password, token) in `payload`. */
  async create(
    client: PoolClient,
    organizationId: string,
    userId: string,
    type: NotificationType,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    await client.query(
      `INSERT INTO tenant.notifications (organization_id, user_id, type, payload)
       VALUES ($1, $2, $3, $4)`,
      [organizationId, userId, type, JSON.stringify(payload)],
    );
  }

  /** Fan out to every active Owner/Admin in the org, optionally skipping the user who caused the event. */
  async notifyAdmins(
    client: PoolClient,
    organizationId: string,
    type: NotificationType,
    payload: Record<string, unknown> = {},
    excludeUserId?: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO tenant.notifications (organization_id, user_id, type, payload)
       SELECT organization_id, id, $2, $3
       FROM tenant.users
       WHERE organization_id = $1
         AND role IN ('owner', 'admin')
         AND status = 'active'
         AND ($4::uuid IS NULL OR id <> $4)`,
      [organizationId, type, JSON.stringify(payload), excludeUserId ?? null],
    );
  }

  /** GET /notifications — own only, newest first, cursor-paginated; `?unreadOnly=true`. */
  async list(organizationId: string, userId: string, filters: NotificationListFilters): Promise<Page<NotificationDto>> {
    const limit = parseLimit(filters.limit);
    const cursorId = decodeCursor(filters.cursor);
    const unreadOnly = this.parseBoolean(filters.unreadOnly, 'unreadOnly');

    const rows = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const { rows } = await client.query<NotificationRow>(
        `SELECT id, type, payload, read_at, created_at
         FROM tenant.notifications
         WHERE user_id = $1
           AND ($2::uuid IS NULL OR id < $2)
           AND (NOT $3::boolean OR read_at IS NULL)
         ORDER BY id DESC
         LIMIT $4`,
        [userId, cursorId, unreadOnly, limit + 1],
      );
      return rows;
    });

    return buildPage(rows, limit, (row) => this.toDto(row));
  }

  /** Unread count for the app shell's bell badge — `meta.unreadCount` on GET /notifications would mix concerns, so it's its own cheap query. */
  async unreadCount(organizationId: string, userId: string): Promise<number> {
    return this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const { rows } = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM tenant.notifications WHERE user_id = $1 AND read_at IS NULL',
        [userId],
      );
      return Number(rows[0].count);
    });
  }

  /** PATCH /notifications/{id} — `{ readAt: "<iso>" }` marks read, `{ readAt: null }` marks unread. */
  async setReadAt(organizationId: string, userId: string, notificationId: string, readAt: Date | null): Promise<NotificationDto> {
    const row = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const { rows } = await client.query<NotificationRow>(
        `UPDATE tenant.notifications SET read_at = $1
         WHERE id = $2 AND user_id = $3
         RETURNING id, type, payload, read_at, created_at`,
        [readAt, notificationId, userId],
      );
      return rows[0];
    });
    if (!row) {
      throw new AppException(404, 'NOT_FOUND', 'Notification not found.');
    }
    return this.toDto(row);
  }

  /** POST /notifications/read-all — marks every unread notification of the caller read; returns how many changed. */
  async markAllRead(organizationId: string, userId: string): Promise<number> {
    return this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const { rowCount } = await client.query(
        'UPDATE tenant.notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL',
        [userId],
      );
      return rowCount ?? 0;
    });
  }

  private parseBoolean(raw: string | undefined, field: string): boolean {
    if (raw === undefined || raw === '' || raw === 'false') return false;
    if (raw === 'true') return true;
    throw new AppException(400, 'VALIDATION_ERROR', `${field} must be true or false.`);
  }

  private toDto(row: NotificationRow): NotificationDto {
    return { id: row.id, type: row.type, payload: row.payload, readAt: row.read_at, createdAt: row.created_at };
  }
}
