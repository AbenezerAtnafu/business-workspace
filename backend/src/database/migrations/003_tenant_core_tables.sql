-- Steps 1.5 (Org Units & Groups mgmt), 1.6 (User Mgmt onboarding), 2.3
-- (Mailbox provisioning), 2.4 (Webmail + attachments), 3.1 (Notifications) —
-- planning/implementation-plan.md. Source: architecture/data-model.md,
-- "Schema: tenant" (remainder after 002).

-- Invites are for the EMAIL-LINK onboarding path only (Path A). They carry
-- TWO distinct email concepts, not one:
--   - domain_id + local_part: the COMPANY address being created (john@acme.com),
--     which only becomes real once the invite is accepted — it cannot receive
--     anything before that, so it can never be a delivery target.
--   - contact_email: the EXTERNAL address (personal/current work email) the
--     invite link is actually sent to. Required for this path, since there is
--     no other deliverable address on an unaccepted invite. When no reachable
--     contact email exists, use the admin-issued-credentials path instead
--     (Path B, which never touches this table at all).
CREATE TABLE tenant.invites (
  id               UUID PRIMARY KEY DEFAULT uuidv7(),
  organization_id  UUID NOT NULL REFERENCES control.organizations(id) ON DELETE CASCADE,
  domain_id        UUID NOT NULL REFERENCES control.domains(id),
  local_part       TEXT NOT NULL,
  contact_email    CITEXT NOT NULL, -- delivery address for the invite link; not a login identity
  role             TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  org_unit_id      UUID REFERENCES tenant.org_units(id), -- NULL = defaults to the org's root unit on acceptance
  token            TEXT NOT NULL UNIQUE,
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at      TIMESTAMPTZ,
  invited_by       UUID NOT NULL REFERENCES tenant.users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX invites_org_idx ON tenant.invites (organization_id);

-- Prevent double-inviting the same company address while a prior invite is still pending
CREATE UNIQUE INDEX invites_pending_unique
  ON tenant.invites (domain_id, local_part) WHERE accepted_at IS NULL;

CREATE TABLE tenant.sessions (
  id                   UUID PRIMARY KEY DEFAULT uuidv7(),
  organization_id      UUID NOT NULL REFERENCES control.organizations(id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES tenant.users(id) ON DELETE CASCADE,
  refresh_token_hash   TEXT NOT NULL,
  device_info          TEXT,
  ip_address           INET,
  expires_at           TIMESTAMPTZ NOT NULL,
  revoked_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sessions_org_idx ON tenant.sessions (organization_id);
CREATE INDEX sessions_user_idx ON tenant.sessions (user_id);

-- Flat (non-hierarchical) named collections of users — unlike org_units,
-- groups don't nest, matching Google Workspace's own Groups model. In MVP,
-- a group's only function is as a grant target for shared mailbox access
-- (tenant.mailbox_access below) — granting a whole team send_as/manage
-- access to support@acme.com in one step instead of one row per member.
CREATE TABLE tenant.groups (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  organization_id UUID NOT NULL REFERENCES control.organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE INDEX groups_org_idx ON tenant.groups (organization_id);

CREATE TABLE tenant.group_members (
  group_id   UUID NOT NULL REFERENCES tenant.groups(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES tenant.users(id) ON DELETE CASCADE,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX group_members_user_idx ON tenant.group_members (user_id);

CREATE TABLE tenant.mailboxes (
  id               UUID PRIMARY KEY DEFAULT uuidv7(),
  organization_id  UUID NOT NULL REFERENCES control.organizations(id) ON DELETE CASCADE,
  user_id          UUID REFERENCES tenant.users(id), -- primary personal owner; null for purely shared mailboxes (e.g. support@)
  domain_id        UUID NOT NULL REFERENCES control.domains(id),
  local_part       TEXT NOT NULL, -- "john" in john@acme.com
  quota_bytes      BIGINT NOT NULL DEFAULT 5368709120, -- 5 GB default
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (domain_id, local_part)
);

CREATE INDEX mailboxes_org_idx ON tenant.mailboxes (organization_id);

-- Complete the deferred FK + uniqueness from tenant.users (002) now that
-- mailboxes exists: a mailbox can be at most one user's *primary* login identity.
ALTER TABLE tenant.users
  ADD CONSTRAINT users_primary_mailbox_fk FOREIGN KEY (primary_mailbox_id) REFERENCES tenant.mailboxes(id),
  ADD CONSTRAINT users_primary_mailbox_unique UNIQUE (primary_mailbox_id);

-- NOTE: message content, folders, flags, and search live in Dovecot (ADR-002).
-- This table tracks provisioning metadata only — it does not duplicate Dovecot's
-- job. A `mail_index` cache table for faster webmail search/threading is optional
-- and deferred unless Dovecot's own search proves too slow for the UI.

CREATE TABLE tenant.mailbox_aliases (
  id                UUID PRIMARY KEY DEFAULT uuidv7(),
  organization_id   UUID NOT NULL REFERENCES control.organizations(id) ON DELETE CASCADE,
  domain_id         UUID NOT NULL REFERENCES control.domains(id),
  alias_local_part  TEXT NOT NULL,
  target_mailbox_id UUID NOT NULL REFERENCES tenant.mailboxes(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (domain_id, alias_local_part)
);

-- Grants a USER or a GROUP access to a domain-based mailbox that isn't their
-- own primary mailbox — e.g. an Admin who can send-as or manage
-- support@acme.com, or an entire "Support" group granted send_as in one
-- step. Deliberately separate from mailboxes.user_id (the single personal
-- owner), since a shared mailbox can have zero owners and several managers.
-- Exactly one of user_id / group_id is set per row (CHECK below).
CREATE TABLE tenant.mailbox_access (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  organization_id UUID NOT NULL REFERENCES control.organizations(id) ON DELETE CASCADE,
  mailbox_id      UUID NOT NULL REFERENCES tenant.mailboxes(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES tenant.users(id) ON DELETE CASCADE,
  group_id        UUID REFERENCES tenant.groups(id) ON DELETE CASCADE,
  access_level    TEXT NOT NULL DEFAULT 'send_as'
                    CHECK (access_level IN ('read_only', 'send_as', 'manage')),
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((user_id IS NOT NULL) <> (group_id IS NOT NULL)) -- exactly one target
);

CREATE UNIQUE INDEX mailbox_access_user_unique  ON tenant.mailbox_access (mailbox_id, user_id)  WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX mailbox_access_group_unique ON tenant.mailbox_access (mailbox_id, group_id) WHERE group_id IS NOT NULL;
CREATE INDEX mailbox_access_org_idx ON tenant.mailbox_access (organization_id);
CREATE INDEX mailbox_access_user_idx ON tenant.mailbox_access (user_id);
CREATE INDEX mailbox_access_group_idx ON tenant.mailbox_access (group_id);

-- Staging area for compose-time attachments. An attachment is uploaded here
-- BEFORE a message is sent (so the compose UI can show upload progress
-- independent of send), then referenced by id on send; the final MIME
-- message — attachment bytes included — is handed to Postfix and becomes
-- part of what Dovecot stores (ADR-002: message content lives in Dovecot,
-- not Postgres). This table only ever holds the pre-send staging copy — see
-- data-model.md's "File storage — scoped to email attachments" for why
-- there's no general-purpose files table in this schema.
CREATE TABLE tenant.attachment_uploads (
  id                  UUID PRIMARY KEY DEFAULT uuidv7(),
  organization_id     UUID NOT NULL REFERENCES control.organizations(id) ON DELETE CASCADE,
  mailbox_id          UUID NOT NULL REFERENCES tenant.mailboxes(id) ON DELETE CASCADE,
  object_storage_key  TEXT NOT NULL,
  file_name           TEXT NOT NULL,
  size_bytes          BIGINT NOT NULL,
  mime_type           TEXT,
  consumed_at         TIMESTAMPTZ, -- set once referenced by a sent message or draft
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX attachment_uploads_org_idx ON tenant.attachment_uploads (organization_id);
CREATE INDEX attachment_uploads_mailbox_idx ON tenant.attachment_uploads (mailbox_id);

-- Unconsumed rows older than ~48h are garbage-collected by a background job
-- (abandoned compose drafts) — see business-rules-and-defaults.md.

CREATE TABLE tenant.notifications (
  id               UUID PRIMARY KEY DEFAULT uuidv7(),
  organization_id  UUID NOT NULL REFERENCES control.organizations(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES tenant.users(id) ON DELETE CASCADE,
  type             TEXT NOT NULL,
  payload          JSONB NOT NULL DEFAULT '{}',
  read_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX notifications_org_idx ON tenant.notifications (organization_id);
CREATE INDEX notifications_user_idx ON tenant.notifications (user_id);

CREATE TABLE tenant.audit_logs (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  organization_id UUID NOT NULL REFERENCES control.organizations(id) ON DELETE CASCADE,
  actor_user_id   UUID REFERENCES tenant.users(id),
  action          TEXT NOT NULL,
  resource_type   TEXT,
  resource_id     UUID,
  ip_address      INET,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_org_idx ON tenant.audit_logs (organization_id);
