import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app-exception';
import { TokensService } from '../../common/tokens/tokens.service';
import { SessionsService } from '../../common/sessions/sessions.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';

export interface BootstrapResult {
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
    role: 'owner';
  };
}

/** GET/PATCH /organization response (api-contract.md §2, "Current org's profile"). */
export interface OrganizationDto {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  defaultTimezone: string;
  defaultLocale: string;
  status: 'active' | 'suspended' | 'deleted';
  ownerUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  default_timezone: string;
  default_locale: string;
  status: OrganizationDto['status'];
  owner_user_id: string;
  created_at: Date;
  updated_at: Date;
}

const ORG_COLUMNS =
  'id, name, slug, logo_url, default_timezone, default_locale, status, owner_user_id, created_at, updated_at';

/** DTO field → column, for the fields PATCH /organization may change. */
const EDITABLE: Record<keyof UpdateOrganizationDto, keyof OrganizationRow> = {
  name: 'name',
  logoUrl: 'logo_url',
  defaultTimezone: 'default_timezone',
  defaultLocale: 'default_locale',
};

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tokens: TokensService,
    private readonly sessions: SessionsService,
    private readonly auditLogs: AuditLogsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /**
   * POST /organizations — architecture/api-contract.md §2 ("Owner signup").
   * Implementation-plan Step 1.3: one transaction creates control.organizations,
   * the root tenant.org_units row, the Owner's tenant.users row (email =
   * ownerContactEmail, primary_mailbox_id left NULL — see data-model.md's
   * "Owner bootstrap"), and control.user_directory.
   *
   * Ordering note (resolved here, not spelled out in data-model.md): the
   * Owner's user id has to exist before control.organizations can be
   * inserted, because owner_user_id is NOT NULL — but tenant.users.org_unit_id
   * is itself NOT NULL and needs tenant.org_units, which needs
   * control.organizations to exist first. That circularity is why
   * migrations/002 marks organizations_owner_fk DEFERRABLE INITIALLY
   * DEFERRED: we pre-generate the owner's id, insert organizations with it
   * already set, and only insert the matching tenant.users row afterward —
   * the FK is checked at COMMIT, once both rows exist.
   *
   * RLS note: tenant.org_units and tenant.users both enforce
   * organization_id = current_setting('app.current_org_id') on INSERT
   * (data-model.md's "Row-Level Security"). There is no earlier request to
   * inherit a tenant context from here, so this is the one path in the app
   * that calls DatabaseService.setTenantContext with an organization id
   * created in the very same transaction, rather than one read off an
   * existing session.
   */
  async bootstrap(dto: CreateOrganizationDto, deviceInfo?: string, ipAddress?: string): Promise<BootstrapResult> {
    // ADR-011: public endpoint that creates an organization — limited per
    // client IP, counted before anything else (a 409 duplicate counts too,
    // so it can't be used to probe registered emails at volume).
    await this.rateLimit.consume(
      this.rateLimit.key('signup', '-', ipAddress),
      this.rateLimit.quota('signupsPerIpPerHour'),
    );
    // "One email = one org" (api-contract.md §0): an address already in
    // control.user_directory — as another org's Owner contact email or as
    // anyone's company mailbox — can't start a second org. Checked up front
    // for a clean 409; the unique-violation catch below covers the race
    // where two signups with the same email land at once. (Added
    // 2026-10-07 — before this, a duplicate fell through as a raw 500.)
    //
    // This does tell a caller that an address is registered. That is
    // inherent to any signup form; login and password reset still never
    // reveal it.
    const existing = await this.db.query('SELECT 1 FROM control.user_directory WHERE email = $1', [
      dto.ownerContactEmail,
    ]);
    if (existing.rows.length > 0) {
      throw this.emailTaken();
    }

    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });

    const { organizationId, ownerId, orgUnitId, sessionId, refreshToken } = await this.db
      .withTransaction(async (client) => {
        const ownerId = await this.generateId(client);
        const organizationId = await this.insertOrganization(client, dto.organizationName, ownerId);

        // See RLS note above: this organization was just created in this
        // same transaction, so there is no earlier request context to
        // inherit it from.
        await this.db.setTenantContext(client, organizationId);

        const orgUnitResult = await client.query<{ id: string }>(
          `INSERT INTO tenant.org_units (organization_id, parent_org_unit_id, name)
           VALUES ($1, NULL, $2)
           RETURNING id`,
          [organizationId, dto.organizationName],
        );
        const orgUnitId = orgUnitResult.rows[0].id;

        await client.query(
          `INSERT INTO tenant.users
             (id, organization_id, org_unit_id, email, name, password_hash, role, status, last_login_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'owner', 'active', now())`,
          [ownerId, organizationId, orgUnitId, dto.ownerContactEmail, dto.ownerName, passwordHash],
        );

        await client.query(
          `INSERT INTO control.user_directory (email, organization_id, user_id)
           VALUES ($1, $2, $3)`,
          [dto.ownerContactEmail, organizationId, ownerId],
        );

        const { sessionId, refreshToken } = await this.sessions.issue(
          client,
          organizationId,
          ownerId,
          deviceInfo,
          ipAddress,
        );

        // Step 3.2: claude/srs.md §7.10 — "Platform-level events (e.g.,
        // organization creation, domain verification outcomes) are indexed
        // in the control-plane database." actor_type is 'system' (not
        // 'platform_admin' — see AuditLogsService.recordPlatform's own doc
        // comment for why this build never has the latter). Deliberately
        // NOT also writing a tenant.audit_logs 'user.created' row for the
        // Owner here: the Owner's account and the organization it belongs
        // to come into existence in the exact same transaction — there is
        // no organization-scoped audit trail to append a "user created"
        // event to that would mean anything separate from "organization
        // created" itself, and business-rules-and-defaults.md's "Account
        // creation events... including the Owner signup path... must be
        // logged" is satisfied by this control-plane entry.
        await this.auditLogs.recordPlatform(client, 'system', 'organization.created', organizationId, {
          organizationName: dto.organizationName,
          ownerEmail: dto.ownerContactEmail,
        });

        return { organizationId, ownerId, orgUnitId, sessionId, refreshToken };
      })
      .catch((err: unknown) => {
        const pgErr = err as { code?: string; constraint?: string };
        if (pgErr?.code === '23505' && pgErr.constraint === 'user_directory_pkey') {
          throw this.emailTaken();
        }
        throw err;
      });

    const accessToken = this.tokens.signAccessToken({
      organizationId,
      userId: ownerId,
      role: 'owner',
      sessionId,
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: ownerId,
        organizationId,
        orgUnitId,
        email: dto.ownerContactEmail,
        name: dto.ownerName,
        role: 'owner',
      },
    };
  }

  private async generateId(client: PoolClient): Promise<string> {
    const { rows } = await client.query<{ uuidv7: string }>('SELECT uuidv7()');
    return rows[0].uuidv7;
  }

  /** organizationName -> a URL-safe slug, unique platform-wide (control.organizations.slug). */
  private async insertOrganization(
    client: PoolClient,
    organizationName: string,
    ownerId: string,
  ): Promise<string> {
    // A short random suffix keeps the slug unique without a retry-with-
    // SAVEPOINT loop inside this transaction (a plain unique-violation retry
    // would otherwise leave the transaction in its aborted state). A
    // same-millisecond collision on both the slugified name AND this suffix
    // is negligible; the rare true collision just fails the whole
    // transaction cleanly, and the client can retry signup.
    const slug = `${this.slugify(organizationName)}-${randomBytes(3).toString('hex')}`;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO control.organizations (name, slug, owner_user_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [organizationName, slug, ownerId],
    );
    return rows[0].id;
  }

  private emailTaken(): AppException {
    return new AppException(
      409,
      'EMAIL_ALREADY_REGISTERED',
      'This email is already registered. Log in instead, or use a different email.',
      { field: 'ownerContactEmail' },
    );
  }

  /**
   * GET /organization — the caller's own org. control.organizations has no
   * RLS (it's control-plane), so the WHERE on the token's organizationId is
   * the isolation here; there is no way to name another org.
   */
  async getCurrent(organizationId: string): Promise<OrganizationDto> {
    const { rows } = await this.db.query<OrganizationRow>(
      `SELECT ${ORG_COLUMNS} FROM control.organizations WHERE id = $1`,
      [organizationId],
    );
    if (!rows[0]) throw new AppException(404, 'NOT_FOUND', 'Organization not found.');
    return this.toDto(rows[0]);
  }

  /**
   * PATCH /organization — Owner/Admin (api-contract.md §2). Only fields that
   * actually change are written; a no-op PATCH returns the org unchanged
   * and writes no audit row. The audit entry (`organization.updated`)
   * records each changed field's before/after — none of these fields is
   * sensitive.
   */
  async update(organizationId: string, actorUserId: string, dto: UpdateOrganizationDto): Promise<OrganizationDto> {
    const row = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const { rows } = await client.query<OrganizationRow>(
        `SELECT ${ORG_COLUMNS} FROM control.organizations WHERE id = $1 FOR UPDATE`,
        [organizationId],
      );
      const current = rows[0];
      if (!current) throw new AppException(404, 'NOT_FOUND', 'Organization not found.');

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const sets: string[] = [];
      const params: unknown[] = [organizationId];
      for (const [field, column] of Object.entries(EDITABLE) as [keyof UpdateOrganizationDto, keyof OrganizationRow][]) {
        const next = dto[field];
        if (next === undefined || next === current[column]) continue;
        changes[field] = { from: current[column], to: next };
        params.push(next);
        sets.push(`${column} = $${params.length}`);
      }
      if (sets.length === 0) return current;

      const { rows: updated } = await client.query<OrganizationRow>(
        `UPDATE control.organizations SET ${sets.join(', ')}, updated_at = now()
         WHERE id = $1 RETURNING ${ORG_COLUMNS}`,
        params,
      );
      await this.auditLogs.record(client, organizationId, actorUserId, 'organization.updated', {
        resourceType: 'organization',
        resourceId: organizationId,
        metadata: { changes },
      });
      return updated[0];
    });
    return this.toDto(row);
  }

  private toDto(r: OrganizationRow): OrganizationDto {
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      logoUrl: r.logo_url,
      defaultTimezone: r.default_timezone,
      defaultLocale: r.default_locale,
      status: r.status,
      ownerUserId: r.owner_user_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 80);
  }

}
