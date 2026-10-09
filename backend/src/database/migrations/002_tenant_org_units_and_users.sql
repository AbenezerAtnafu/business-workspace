-- Step 1.2 (planning/implementation-plan.md) — the tenant/RLS foundation.
-- Source: architecture/data-model.md, "Schema: tenant" (org_units + users
-- portion only — see 003 for the rest).
--
-- org_units is defined BEFORE users so users.org_unit_id can FK into it
-- directly, no deferred ALTER needed: a user row can't be inserted until a
-- root unit exists to point it at.

CREATE SCHEMA tenant;

-- A hierarchy of organizational units WITHIN one organization — structural/
-- directory grouping only in MVP (unlike Google Workspace's OUs, these do
-- NOT carry per-unit policy enforcement yet; see data-model.md's
-- "Organizational Units & Groups" section). Every organization gets exactly
-- one root unit (parent_org_unit_id IS NULL), auto-created at signup as part
-- of the Owner bootstrap transaction (Step 1.3) — every user always has a
-- unit, even one that has never customized its structure.
CREATE TABLE tenant.org_units (
  id                 UUID PRIMARY KEY DEFAULT uuidv7(),
  organization_id    UUID NOT NULL REFERENCES control.organizations(id) ON DELETE CASCADE,
  parent_org_unit_id UUID REFERENCES tenant.org_units(id), -- NULL = root
  name               TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX org_units_org_idx ON tenant.org_units (organization_id);
CREATE INDEX org_units_parent_idx ON tenant.org_units (parent_org_unit_id);

-- Exactly one root unit per organization
CREATE UNIQUE INDEX org_units_one_root_per_org
  ON tenant.org_units (organization_id) WHERE parent_org_unit_id IS NULL;

CREATE TABLE tenant.users (
  id                   UUID PRIMARY KEY DEFAULT uuidv7(),
  organization_id      UUID NOT NULL REFERENCES control.organizations(id) ON DELETE CASCADE,
  org_unit_id          UUID NOT NULL REFERENCES tenant.org_units(id), -- every user belongs to exactly one unit; defaults to the org's root unit
  email                CITEXT NOT NULL, -- cached from primary_mailbox_id; see data-model.md note
  primary_mailbox_id   UUID, -- FK added in 003, after tenant.mailboxes exists; nullable — see "Owner bootstrap"
  name                 TEXT NOT NULL,
  password_hash        TEXT NOT NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT false, -- true after admin-issued temp password; see "Onboarding" in data-model.md
  status               TEXT NOT NULL DEFAULT 'invited'
                         CHECK (status IN ('invited', 'active', 'suspended', 'deleted')),
  role                 TEXT NOT NULL DEFAULT 'member'
                         CHECK (role IN ('owner', 'admin', 'member')),
  mfa_enabled          BOOLEAN NOT NULL DEFAULT false,
  mfa_secret           TEXT, -- encrypted at rest
  last_login_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, email)
);

CREATE INDEX users_org_idx ON tenant.users (organization_id);
CREATE INDEX users_org_unit_idx ON tenant.users (org_unit_id);

-- Now that tenant.users exists, complete the cross-schema FK deferred in 001.
--
-- DEFERRABLE INITIALLY DEFERRED (not in the original data-model.md sketch —
-- added here because the Owner-bootstrap transaction needs it): signup has
-- a three-way circular ordering problem. control.organizations.owner_user_id
-- is NOT NULL, so it needs the Owner's tenant.users.id before it can be
-- inserted — but tenant.users.org_unit_id is itself NOT NULL and needs a row
-- in tenant.org_units, which needs control.organizations.id to exist first.
-- Making this one FK deferred lets the bootstrap transaction insert
-- control.organizations with owner_user_id already set to a pre-generated
-- id, then insert tenant.org_units and tenant.users afterward in the same
-- transaction — Postgres only checks the FK at COMMIT, by which point both
-- rows exist. See src/modules/organizations/organizations.service.ts.
ALTER TABLE control.organizations
  ADD CONSTRAINT organizations_owner_fk FOREIGN KEY (owner_user_id) REFERENCES tenant.users(id)
  DEFERRABLE INITIALLY DEFERRED;
