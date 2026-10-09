-- 2026-10-07 — same soft-delete gap ADR-007 fixed for tenant.mailboxes,
-- this time on tenant.users.
--
-- 002 created tenant.users with a table-wide UNIQUE (organization_id, email).
-- Deleting a user is a soft delete (status = 'deleted'), so the deleted row
-- kept its email forever. Once that person's mailbox was deleted and the
-- address freed, creating a new account at the same address failed with a
-- raw unique-violation 500. Found while building the Phase 2 Mailboxes
-- screens (delete user → delete mailbox → recreate the address).
--
-- Fix: a partial unique index covering live (non-deleted) users only — the
-- pattern invites (invites_pending_unique) and mailboxes (migration 011)
-- already use. Idempotent.

ALTER TABLE tenant.users DROP CONSTRAINT IF EXISTS users_organization_id_email_key;

CREATE UNIQUE INDEX IF NOT EXISTS users_organization_id_email_live_unique
  ON tenant.users (organization_id, email) WHERE status <> 'deleted';
