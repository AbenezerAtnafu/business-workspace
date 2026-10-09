import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient, QueryResultRow } from 'pg';

/**
 * Thin wrapper around a single pg Pool for the one Postgres instance that
 * holds both the control and tenant schemas (architecture/data-model.md —
 * "Implementation note on two databases"). No ORM: raw SQL against the
 * migrations in src/database/migrations, matching how those files are
 * written and reviewed.
 *
 * Connects using `database.appUrl` (APP_DATABASE_URL) — a dedicated,
 * non-superuser, non-BYPASSRLS role — never `database.url` (DATABASE_URL,
 * the migration runner's superuser role). See
 * src/database/migrations/006_app_runtime_role.sql: this distinction isn't
 * cosmetic — a superuser connection bypasses every RLS policy from
 * migration 004 unconditionally, silently defeating tenant isolation no
 * matter how carefully setTenantContext() is called below. Failing fast
 * here (rather than falling back to database.url) is deliberate, for the
 * same reason.
 *
 * Also holds a second, separate pool on `database.bootstrapUrl`
 * (APP_BOOTSTRAP_DATABASE_URL) — a third, read-only, BYPASSRLS role, used
 * only via queryBypassingRls() below, for the narrow set of lookups that
 * must run before the organization is known at all. See
 * src/database/migrations/008_app_bootstrap_role.sql for why app_user
 * alone can't serve those (RLS can't scope a query to an org nobody has
 * identified yet, and a Postgres quirk around how a locally-set GUC rests
 * after commit turns that into a 500 rather than just an empty result).
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool: Pool;
  private readonly bootstrapPool: Pool;

  constructor(private readonly configService: ConfigService) {
    const appUrl = this.configService.get<string>('database.appUrl');
    if (!appUrl) {
      throw new Error(
        'APP_DATABASE_URL is not set. The application must connect to Postgres as a ' +
          'non-superuser, non-BYPASSRLS role (see migrations/006_app_runtime_role.sql) — ' +
          'falling back to DATABASE_URL would silently disable every tenant.* RLS policy, ' +
          'since that role is the migration superuser.',
      );
    }
    this.pool = new Pool({ connectionString: appUrl });

    const bootstrapUrl = this.configService.get<string>('database.bootstrapUrl');
    if (!bootstrapUrl) {
      throw new Error(
        'APP_BOOTSTRAP_DATABASE_URL is not set. A handful of lookups (refresh-token, ' +
          'MFA challenge, invite-token preview) must run before the organization is known ' +
          'and cannot go through the ordinary RLS-scoped app_user role — see ' +
          'migrations/008_app_bootstrap_role.sql. Falling back to appUrl would make those ' +
          'lookups fail (empty result, or a 500 under the empty-string GUC quirk documented ' +
          'there), and falling back to the superuser url would defeat RLS outright.',
      );
    }
    this.bootstrapPool = new Pool({ connectionString: bootstrapUrl });
  }

  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
    return this.pool.query<T>(text, params);
  }

  /**
   * Runs a query against the read-only, BYPASSRLS `app_bootstrap` role
   * (migrations/008_app_bootstrap_role.sql) instead of the ordinary
   * app_user pool. ONLY for a lookup that must run before the organization
   * is known, keyed on an unguessable, unique, high-entropy secret (a
   * hashed refresh/auth token, an invite token) — never for anything an
   * ordinary tenant-scoped query (query() inside a withTransaction +
   * setTenantContext()) could serve instead. Using this for the wrong
   * thing silently defeats RLS for that query, the same mistake migration
   * 006 fixed at the connection-role level — this method just makes the
   * three narrow, deliberate exceptions to that rule explicit and greppable
   * in application code, rather than indistinguishable from an ordinary
   * query() call.
   */
  queryBypassingRls<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
    return this.bootstrapPool.query<T>(text, params);
  }

  /**
   * Runs `fn` inside a BEGIN/COMMIT transaction on a dedicated client,
   * rolling back on any thrown error. Use this (not `query`) for anything
   * that writes more than one row across one or more tables — every
   * multi-table write in architecture/data-model.md (Owner bootstrap,
   * onboarding paths, ownership transfer, ...) is one transaction, not
   * several independent queries.
   */
  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Sets the per-transaction RLS context (architecture/data-model.md —
   * "Row-Level Security"). Uses set_config(), not a string-interpolated
   * `SET LOCAL app.current_org_id = '...'`, so organizationId travels as a
   * bound parameter rather than being concatenated into SQL. The third
   * argument (`true`) is set_config's `is_local` flag — the parameterized
   * equivalent of SET LOCAL, scoped to the current transaction and reset
   * automatically on COMMIT/ROLLBACK (safe under PgBouncer transaction
   * pooling, per SRS §8.1).
   */
  async setTenantContext(client: PoolClient, organizationId: string): Promise<void> {
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org_id', organizationId]);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
    await this.bootstrapPool.end();
  }
}
