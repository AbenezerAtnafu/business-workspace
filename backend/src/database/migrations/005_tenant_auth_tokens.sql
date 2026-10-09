-- Step 1.4 (password reset + MFA sub-slices) — short-lived, single-use,
-- bootstrap-before-tenant-context tokens: self-service password reset
-- links and MFA challenge tokens share an identical shape (organization_id,
-- user_id, a hashed secret, an expiry, a used_at consumption marker), so one
-- table with a `purpose` column replaces what would otherwise be two
-- near-identical ones. Looked up the same way tenant.sessions already is
-- (common/auth-tokens/auth-tokens.service.ts): by token_hash, with no
-- tenant context yet, because the organization isn't known until the
-- lookup returns it — the same "login flow" bootstrap pattern documented
-- at the bottom of 004_tenant_rls.sql, just keyed by an opaque token
-- instead of an email address.

CREATE TABLE tenant.auth_tokens (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  organization_id UUID NOT NULL REFERENCES control.organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES tenant.users(id) ON DELETE CASCADE,
  purpose         TEXT NOT NULL CHECK (purpose IN ('password_reset', 'mfa_challenge')),
  token_hash      TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX auth_tokens_org_idx ON tenant.auth_tokens (organization_id);
CREATE INDEX auth_tokens_user_idx ON tenant.auth_tokens (user_id);
CREATE UNIQUE INDEX auth_tokens_hash_idx ON tenant.auth_tokens (token_hash);

ALTER TABLE tenant.auth_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant.auth_tokens
  USING (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);
