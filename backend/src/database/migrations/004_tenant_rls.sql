-- Step 1.2 (planning/implementation-plan.md) — the RLS half of the
-- tenant/RLS foundation. Source: architecture/data-model.md, "Row-Level
-- Security". Enable RLS on every tenant.* table and enforce organization_id
-- equality against a per-transaction session variable.
--
-- Application connection, at the start of every request/transaction:
--   SET LOCAL app.current_org_id = '<organization_id from the authenticated session>';
--
-- SET LOCAL (not plain SET) is deliberate: it scopes the setting to the
-- current transaction and resets automatically when the transaction ends —
-- this is what makes RLS safe under PgBouncer in transaction-pooling mode
-- (SRS §8.1) with no extra manual reset logic, since there is no stale
-- session variable to leak onto the next pooled transaction.
--
-- Background jobs / platform admin tooling that must legitimately read
-- across all organizations should connect as a separate Postgres role with
-- BYPASSRLS, kept distinct from the application's main connection role.
-- Never grant BYPASSRLS to the role the API uses for ordinary tenant requests.

ALTER TABLE tenant.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant.users
  USING (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE tenant.org_units ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant.org_units
  USING (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE tenant.invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant.invites
  USING (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE tenant.sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant.sessions
  USING (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE tenant.groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant.groups
  USING (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

-- tenant.group_members has no organization_id column of its own — isolation
-- is enforced transitively via its FK to tenant.groups, which is itself
-- RLS-protected. No separate policy is needed (and none would have a column
-- to filter on).

ALTER TABLE tenant.mailboxes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant.mailboxes
  USING (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE tenant.mailbox_aliases ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant.mailbox_aliases
  USING (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE tenant.mailbox_access ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant.mailbox_access
  USING (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE tenant.attachment_uploads ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant.attachment_uploads
  USING (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE tenant.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant.notifications
  USING (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE tenant.audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant.audit_logs
  USING (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

-- Login flow (data-model.md "Row-Level Security" — resolves the chicken-and-
-- egg problem of needing an organization context before RLS can find a user):
--   1. Look up the submitted email in control.user_directory (no RLS — that
--      table is intentionally in the control-plane schema) to get organization_id.
--   2. SET LOCAL app.current_org_id to that value.
--   3. Query tenant.users for the matching row and verify the password hash.
