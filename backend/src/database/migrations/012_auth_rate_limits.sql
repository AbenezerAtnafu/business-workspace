-- Rate limiting for credential-guessing endpoints — planning/business-rules-
-- and-defaults.md: "/auth/login: 10 attempts / 15 min per account+IP,
-- exponential backoff"; api-contract.md §0: "A 429 response includes
-- Retry-After." Added 2026-10-07 (it was planned for Step 1.4 but never
-- built — see claude/build-progress.md, Known gaps).
--
-- Postgres rather than in-process memory so the limit holds across every API
-- instance behind a load balancer and survives restarts. control schema, no
-- RLS: rows are keyed before (login) or independently of (MFA challenge) any
-- tenant context, and they hold no tenant data — `key` is a SHA-256 of the
-- scope + identifier + IP, never the raw email or token.

CREATE TABLE control.auth_rate_limits (
  key               TEXT PRIMARY KEY,           -- sha256 hex of "<scope>|<identifier>|<ip>"
  failures          INTEGER NOT NULL DEFAULT 0, -- failed attempts in the current window
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lockouts          INTEGER NOT NULL DEFAULT 0, -- consecutive lockouts; drives the exponential backoff
  locked_until      TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- For an occasional cleanup of idle rows (DELETE ... WHERE updated_at < now() - interval '1 day').
CREATE INDEX auth_rate_limits_updated_idx ON control.auth_rate_limits (updated_at);

-- 006's ALTER DEFAULT PRIVILEGES already covers new control.* tables for
-- app_user; granted explicitly too so this doesn't depend on which role ran
-- the migration.
GRANT SELECT, INSERT, UPDATE, DELETE ON control.auth_rate_limits TO app_user;
