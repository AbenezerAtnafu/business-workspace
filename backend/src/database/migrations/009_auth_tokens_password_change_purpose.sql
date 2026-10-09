-- Step 1.6: completes the mustChangePassword branch of POST /auth/login
-- (architecture/api-contract.md §1's "Login flow, in full"), left stubbed
-- as 501 NOT_IMPLEMENTED since Step 1.4 because it depends on Path B
-- admin-issued temp passwords, which didn't exist until this step.
--
-- Adds a third value to tenant.auth_tokens.purpose: 'password_change',
-- backing the passwordChangeToken issued on login when
-- must_change_password is true, consumed by the new POST
-- /auth/password-change. Same table, same lifecycle (short-lived,
-- single-use, bootstrap-before-tenant-context) as 'password_reset' and
-- 'mfa_challenge' — see 005_tenant_auth_tokens.sql's comment for why
-- these three share one table instead of three near-identical ones.
ALTER TABLE tenant.auth_tokens DROP CONSTRAINT auth_tokens_purpose_check;
ALTER TABLE tenant.auth_tokens
  ADD CONSTRAINT auth_tokens_purpose_check
  CHECK (purpose IN ('password_reset', 'mfa_challenge', 'password_change'));
