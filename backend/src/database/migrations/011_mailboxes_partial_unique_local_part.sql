-- Step 2.3 (Mailbox provisioning) — schema gap found live while building
-- soft-delete (DELETE /mailboxes/{id} sets status = 'deleted').
--
-- 003 created tenant.mailboxes with a table-wide UNIQUE (domain_id,
-- local_part). Once mailboxes can be soft-deleted, that constraint keeps a
-- deleted mailbox's address permanently blocked at the database level, even
-- though MailboxesService.assertSlotAvailable() correctly treats a deleted
-- mailbox's slot as free. Recreating support@acme.com after deleting it
-- failed with a raw unique-violation 500 instead of succeeding.
--
-- Fix: replace the constraint with a partial unique index that only covers
-- live (non-deleted) mailboxes — the same "a freed slot is reusable" shape
-- tenant.invites already uses (invites_pending_unique, migration 003).
--
-- See ADR-007. (Reconstructed 2026-10-07 under its original filename and
-- index name: the original file never reached the Mac copy of this repo.
-- Idempotent, so it's harmless on a database that already has it.)

ALTER TABLE tenant.mailboxes DROP CONSTRAINT IF EXISTS mailboxes_domain_id_local_part_key;

CREATE UNIQUE INDEX IF NOT EXISTS mailboxes_domain_id_local_part_active_unique
  ON tenant.mailboxes (domain_id, local_part) WHERE status <> 'deleted';
