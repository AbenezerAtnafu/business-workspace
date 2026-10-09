-- Fixes a second, more subtle RLS gap than the one migration 006 fixed.
--
-- Three call sites deliberately query a tenant.* table with NO
-- organization context set yet, because the organization isn't known
-- until the lookup returns it: SessionsService.findActiveByRawToken
-- (tenant.sessions, backing POST /auth/refresh), AuthTokensService.findValid
-- (tenant.auth_tokens, backing POST /auth/mfa/challenge and POST
-- /auth/password-reset/confirm), and the new invite-token preview lookup
-- (tenant.invites, backing GET /invites/{token}). Each is safe to run
-- across every organization's rows because the lookup key is an
-- unguessable, unique, high-entropy secret (a hashed refresh/auth token, or
-- an invite token) — a match can only ever be produced by whoever already
-- holds that exact secret, so there is nothing to leak by not scoping the
-- query to one org ahead of time.
--
-- Discovered while live-testing POST /auth/refresh immediately after
-- migration 006 (the app_user fix) was wired in: it started failing with
-- "invalid input syntax for type uuid: ''", not the zero-rows-returned
-- failure that was expected. Root cause, reproduced directly in psql:
--
--   BEGIN; SELECT set_config('app.current_org_id', 'some-value', true); COMMIT;
--   SELECT current_setting('app.current_org_id', true);  -- returns '', NOT NULL
--
-- The first time a custom (placeholder) GUC like app.current_org_id is
-- referenced on a connection, Postgres registers it for that SESSION with
-- an empty-string default. set_config(..., true) ("SET LOCAL" semantics)
-- only rolls the value back to that default at COMMIT/ROLLBACK — it does
-- NOT un-register the GUC, so the "resting" value on a connection that has
-- previously run ANY tenant-scoped transaction is '', not NULL as the RLS
-- policy comment in migrations/004 assumed. Every pooled connection in
-- DatabaseService's Pool is shared across unrelated requests, so after a
-- handful of ordinary (correctly tenant-scoped) requests, most connections
-- in the pool are in this tainted '' state — making the three call sites
-- above fail close to 100% of the time in steady state, not as a rare race.
-- `organization_id = ''::uuid` throws (invalid UUID syntax) rather than
-- evaluating to false, which is why this surfaced as a 500, not a 401/404.
--
-- A second non-superuser role, distinct from both the migration runner
-- (postgres, migration 006 removed from the app's own runtime path) and
-- the app's ordinary per-request role (app_user, scoped by RLS), with
-- BYPASSRLS — exactly what architecture/data-model.md's own RLS section
-- anticipates ("Background jobs / platform admin tooling that must
-- legitimately read across all organizations... should connect as a
-- separate Postgres role with BYPASSRLS, kept distinct from the role the
-- application API uses for ordinary tenant requests"), and what ADR-004
-- flagged as a necessary future consequence. BYPASSRLS sidesteps the
-- current_setting() value entirely — correct regardless of whatever that
-- GUC happens to be resting at on a given pooled connection.
--
-- Deliberately read-only (SELECT only, on exactly the three tables that
-- need this): every write these services make (consume/rotate/revoke) is
-- made after the organization IS known, inside an ordinary app_user
-- transaction with setTenantContext() already called — RLS is fully in
-- effect for those, as it should be. There is no ALTER DEFAULT PRIVILEGES
-- here, unlike migration 006's app_user grants — this role's whole point is
-- a narrow, enumerated exception, not a general-purpose runtime identity,
-- so a future table needing this same treatment should get its own
-- explicit GRANT line here, not inherit one silently.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_bootstrap') THEN
    CREATE ROLE app_bootstrap WITH LOGIN PASSWORD 'app_bootstrap_dev_password'
      NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

-- A table grant alone isn't enough to reach it — Postgres also requires
-- USAGE on the schema the table lives in (caught live: the first run of
-- this migration granted the table privileges below but still failed with
-- "permission denied for schema tenant" on the very first real query,
-- since migration 006's app_user grants never needed this for app_bootstrap
-- — app_user gets its schema access from being the role these tables'
-- DEFAULT PRIVILEGES already target, which app_bootstrap, as a brand-new,
-- separately-scoped role, does not inherit).
GRANT USAGE ON SCHEMA tenant TO app_bootstrap;

GRANT SELECT ON tenant.sessions TO app_bootstrap;
GRANT SELECT ON tenant.auth_tokens TO app_bootstrap;
GRANT SELECT ON tenant.invites TO app_bootstrap;
