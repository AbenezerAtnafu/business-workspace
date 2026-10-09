-- Step 1.1 (planning/implementation-plan.md). Source: architecture/data-model.md,
-- "Schema: control". Pure scaffolding — no RLS dependency, can be stood up
-- before the tenant/RLS foundation in 002.

CREATE SCHEMA control;

CREATE TABLE control.organizations (
  id               UUID PRIMARY KEY DEFAULT uuidv7(),
  name             TEXT NOT NULL,
  slug             TEXT NOT NULL UNIQUE,
  logo_url         TEXT,
  default_timezone TEXT NOT NULL DEFAULT 'UTC',
  default_locale   TEXT NOT NULL DEFAULT 'en',
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'suspended', 'deleted')),
  owner_user_id    UUID NOT NULL, -- FK added in 002, after tenant.users exists
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Thin, RLS-free directory used ONLY to resolve "which organization does this
-- email belong to" during login, before any tenant-plane RLS context exists.
-- One email = one organization in MVP (see business-rules-and-defaults.md).
CREATE TABLE control.user_directory (
  email           CITEXT PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES control.organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL -- mirrors tenant.users.id, kept in sync by the app
);

CREATE TABLE control.domains (
  id                  UUID PRIMARY KEY DEFAULT uuidv7(),
  organization_id     UUID NOT NULL REFERENCES control.organizations(id) ON DELETE CASCADE,
  domain_name         TEXT NOT NULL UNIQUE, -- a domain can be claimed by only one org, platform-wide
  verification_token  TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'pending'
                         CHECK (verification_status IN ('pending', 'verified', 'failed')),
  dkim_selector       TEXT,
  dkim_private_key    TEXT, -- encrypted at rest (pgcrypto or app-layer envelope encryption)
  dkim_public_key     TEXT,
  is_primary          BOOLEAN NOT NULL DEFAULT false,
  verified_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only one primary domain per organization
CREATE UNIQUE INDEX domains_one_primary_per_org
  ON control.domains (organization_id) WHERE is_primary;

CREATE INDEX domains_org_idx ON control.domains (organization_id);

-- Placeholder only — not populated or used until billing design resumes (ADR-003)
CREATE TABLE control.subscriptions (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  organization_id UUID NOT NULL REFERENCES control.organizations(id) ON DELETE CASCADE,
  plan            TEXT,
  status          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE control.audit_logs (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  organization_id UUID REFERENCES control.organizations(id) ON DELETE SET NULL,
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('platform_admin', 'system')),
  action          TEXT NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
