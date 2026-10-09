-- 015 — Read-only lookup views for the mail servers (Step 2.1, ADR-012).
--
-- Postfix and Dovecot query Postgres live (architecture/domain-and-email-flow.md:
-- "Postfix queries Postgres directly at runtime ... rather than relying on a
-- separately-synced config file"). They must not get table access, and must
-- not get BYPASSRLS: they get SELECT on these views only, through their own
-- role, `mail_reader`.
--
-- The views live in their own schema and are owned by `postgres`, so they read
-- across every organization (that is their job: an inbound message's recipient
-- decides the org) while exposing only the columns mail delivery needs. Nothing
-- here is writable. All addresses are lower-cased, matching the app's local-part
-- rule (lowercase only) and domain storage (lowercase).
--
-- Rules encoded here (one place, so Postfix and Dovecot can't disagree):
--   * A domain receives mail only when verified, and its organization is active.
--   * A mailbox receives mail only when status = 'active' (suspended → rejected
--     at RCPT TO, like an unknown address).
--   * Mail-client login (IMAP / SMTP AUTH) only for a PERSONAL, active mailbox
--     whose user is 'active', has no pending forced password change, and has
--     MFA off: a password alone must not bypass MFA. App passwords are the
--     follow-up that lets MFA users use mail clients (ADR-012).
--   * Who may send as an address: the mailbox's owner, and anyone holding a
--     `send_as` or `manage` grant on it — directly or through a group.

CREATE SCHEMA IF NOT EXISTS mail;

-- Verified domains of active organizations.
CREATE OR REPLACE VIEW mail.domains AS
SELECT lower(d.domain_name) AS domain_name,
       d.id                 AS domain_id,
       d.organization_id
FROM control.domains d
JOIN control.organizations o ON o.id = d.organization_id
WHERE d.verification_status = 'verified'
  AND o.status = 'active';

-- Deliverable mailboxes (personal and shared). `maildir` is relative to the
-- Dovecot mail root and keyed on stable ids — never on the address, which
-- changes when an Owner claims a mailbox or a user is renamed.
CREATE OR REPLACE VIEW mail.mailboxes AS
SELECT lower(m.local_part || '@' || d.domain_name) AS address,
       m.id                                        AS mailbox_id,
       m.organization_id,
       m.user_id,
       (m.user_id IS NULL)                          AS is_shared,
       m.quota_bytes,
       m.organization_id::text || '/' || m.id::text AS maildir
FROM tenant.mailboxes m
JOIN mail.domains d ON d.domain_id = m.domain_id
WHERE m.status = 'active';

-- Alias address → target mailbox address (only while the target is deliverable).
CREATE OR REPLACE VIEW mail.aliases AS
SELECT lower(a.alias_local_part || '@' || d.domain_name) AS address,
       mb.address                                        AS target_address
FROM tenant.mailbox_aliases a
JOIN mail.domains d    ON d.domain_id = a.domain_id
JOIN mail.mailboxes mb ON mb.mailbox_id = a.target_mailbox_id;

-- Mail-client credentials: login = the user's own mailbox address.
CREATE OR REPLACE VIEW mail.logins AS
SELECT mb.address       AS login,
       u.password_hash,
       mb.mailbox_id,
       mb.organization_id,
       mb.quota_bytes,
       mb.maildir
FROM mail.mailboxes mb
JOIN tenant.users u ON u.id = mb.user_id AND u.primary_mailbox_id = mb.mailbox_id
WHERE u.status = 'active'
  AND u.must_change_password = false
  AND u.mfa_enabled = false;

-- Which logins may use which From/envelope-sender address on authenticated
-- submission (Postfix smtpd_sender_login_maps). One row per (address, login).
CREATE OR REPLACE VIEW mail.sender_logins AS
WITH sendable AS (
  -- every address that delivers to a mailbox: its own address and its aliases
  SELECT mb.mailbox_id, mb.address FROM mail.mailboxes mb
  UNION
  SELECT mb.mailbox_id, a.address
  FROM mail.aliases a JOIN mail.mailboxes mb ON mb.address = a.target_address
),
senders AS (
  -- the owner
  SELECT mb.mailbox_id, mb.user_id FROM mail.mailboxes mb WHERE mb.user_id IS NOT NULL
  UNION
  -- direct send_as / manage grants
  SELECT g.mailbox_id, g.user_id
  FROM tenant.mailbox_access g
  WHERE g.user_id IS NOT NULL AND g.access_level IN ('send_as', 'manage')
  UNION
  -- grants through a group
  SELECT g.mailbox_id, gm.user_id
  FROM tenant.mailbox_access g
  JOIN tenant.group_members gm ON gm.group_id = g.group_id
  WHERE g.group_id IS NOT NULL AND g.access_level IN ('send_as', 'manage')
)
SELECT s.address, l.login
FROM sendable s
JOIN senders x      ON x.mailbox_id = s.mailbox_id
JOIN tenant.users u ON u.id = x.user_id
JOIN mail.logins l  ON l.mailbox_id = u.primary_mailbox_id;

-- DKIM selector per signing domain (keys themselves are exported to the
-- signer's key directory by backend/scripts/export-dkim-keys.mjs; the private
-- key never leaves the app's encryption boundary through this view).
CREATE OR REPLACE VIEW mail.dkim_selectors AS
SELECT lower(d.domain_name) AS domain_name, d.dkim_selector AS selector
FROM control.domains d
JOIN mail.domains md ON md.domain_id = d.id
WHERE d.dkim_selector IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mail_reader') THEN
    -- Dev-only password (same convention as 006/008); rotate with
    -- ALTER ROLE mail_reader PASSWORD '...' on any real server.
    CREATE ROLE mail_reader LOGIN PASSWORD 'mail_reader_dev_password'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

-- Views only: no USAGE on control/tenant, no table grants.
GRANT USAGE ON SCHEMA mail TO mail_reader;
GRANT SELECT ON mail.domains, mail.mailboxes, mail.aliases, mail.logins,
  mail.sender_logins, mail.dkim_selectors TO mail_reader;

-- The DKIM key exporter (backend/scripts/export-dkim-keys.mjs) gets its own
-- role and its own view: the ENCRYPTED private keys of signing domains, and
-- nothing else. mail_reader (Postfix/Dovecot) never sees key material.
CREATE OR REPLACE VIEW mail.dkim_keys AS
SELECT lower(d.domain_name) AS domain_name, d.dkim_selector AS selector,
       d.dkim_private_key AS encrypted_private_key
FROM control.domains d
JOIN mail.domains md ON md.domain_id = d.id
WHERE d.dkim_selector IS NOT NULL AND d.dkim_private_key IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dkim_exporter') THEN
    CREATE ROLE dkim_exporter LOGIN PASSWORD 'dkim_exporter_dev_password'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA mail TO dkim_exporter;
GRANT SELECT ON mail.dkim_keys TO dkim_exporter;
