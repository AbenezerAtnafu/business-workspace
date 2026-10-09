-- Step 1.5 follow-on — NOT in the implementation plan, a real pre-existing
-- gap surfaced while building Org Units & Groups' role-gated endpoints.
--
-- Every tenant.* table has had RLS policies since migration 004, and every
-- service method has faithfully called DatabaseService.setTenantContext
-- (SET LOCAL app.current_org_id) before touching them since Step 1.3. But
-- the only DB role configured anywhere — DATABASE_URL, used by both the
-- migration runner AND (until this migration) the NestJS app itself — is
-- `postgres`, the cluster superuser. PostgreSQL superusers bypass row
-- security UNCONDITIONALLY; there is no setting that changes this, and
-- critically, FORCE ROW LEVEL SECURITY (the clause people reach for here)
-- does NOT help — it only ever affects the table's OWNER, never a
-- superuser, and superuser is a stronger bypass than ownership.
--
-- The practical effect, found while writing OrgUnitsService's cross-org
-- tests: every "a cross-org id returns 404" guarantee this project has
-- claimed since Step 1.3 has been true only because application code
-- happened to always filter correctly, never because the database was
-- actually enforcing it. A single missing WHERE organization_id = ... in
-- any future query would have silently leaked another tenant's rows, and
-- nothing — RLS included — would have caught it.
--
-- Fix: a dedicated, non-superuser, non-BYPASSRLS application role for the
-- app's actual runtime connection pool (APP_DATABASE_URL — see .env.example,
-- src/config/configuration.ts, src/database/database.service.ts, all
-- updated alongside this migration). DATABASE_URL / the `postgres` role
-- becomes migrations-only from this point on. Because `postgres` owns every
-- table created by migrations 001-005, app_user is a non-owner role — RLS
-- policies bind to it unconditionally, with no FORCE ROW LEVEL SECURITY
-- needed (that clause is specifically for when the owner itself must also
-- be restricted, which doesn't apply here).
--
-- ALTER DEFAULT PRIVILEGES is what keeps this from silently regressing on
-- every future migration: any table `postgres` creates in `control` or
-- `tenant` from this point on automatically grants app_user the same DML
-- verbs, with no separate GRANT statement to remember per migration.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    -- Dev-only password, matching this repo's existing convention of
    -- committing a working local DATABASE_URL (postgres/postgres) in
    -- .env.example — rotate both before any non-local deployment.
    CREATE ROLE app_user LOGIN PASSWORD 'app_user_dev_password'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA control, tenant TO app_user;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA control TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA tenant TO app_user;

-- Called directly from app code (e.g. OrganizationsService.generateId via
-- `SELECT uuidv7()`), not only from DEFAULT clauses evaluated internally by
-- Postgres itself (which run with the table owner's privileges regardless
-- of the connected role) — app_user needs its own EXECUTE grant.
GRANT EXECUTE ON FUNCTION public.uuidv7() TO app_user;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA control
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA tenant
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
