-- 016 — tenant.attachment_uploads (Step 2.4, architecture/data-model.md).
--
-- Staging for compose attachments: uploaded first (so the UI can show
-- progress), then referenced by id when a message is sent or a draft saved.
-- After that the bytes live inside the MIME message Dovecot stores; this row
-- only records the pre-send copy. Unconsumed rows older than 48 h are
-- garbage-collected (business-rules-and-defaults.md), along with their files.
--
-- object_storage_key is a path relative to ATTACHMENT_STORAGE_DIR in this
-- build (a volume); the column name leaves room for S3-style object storage.
-- uploaded_by is added beyond data-model.md so one user can't attach another
-- user's staged upload, even within the same mailbox.

CREATE TABLE IF NOT EXISTS tenant.attachment_uploads (
  id                  UUID PRIMARY KEY DEFAULT uuidv7(),
  organization_id     UUID NOT NULL REFERENCES control.organizations(id) ON DELETE CASCADE,
  mailbox_id          UUID NOT NULL REFERENCES tenant.mailboxes(id) ON DELETE CASCADE,
  uploaded_by         UUID NOT NULL REFERENCES tenant.users(id) ON DELETE CASCADE,
  object_storage_key  TEXT NOT NULL,
  file_name           TEXT NOT NULL,
  size_bytes          BIGINT NOT NULL CHECK (size_bytes >= 0),
  mime_type           TEXT,
  consumed_at         TIMESTAMPTZ, -- set once referenced by a sent message or a saved draft
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS attachment_uploads_org_idx ON tenant.attachment_uploads (organization_id);
CREATE INDEX IF NOT EXISTS attachment_uploads_mailbox_idx ON tenant.attachment_uploads (mailbox_id);
CREATE INDEX IF NOT EXISTS attachment_uploads_gc_idx ON tenant.attachment_uploads (created_at) WHERE consumed_at IS NULL;

ALTER TABLE tenant.attachment_uploads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant.attachment_uploads;
CREATE POLICY tenant_isolation ON tenant.attachment_uploads
  USING (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

-- 006's default privileges already grant app_user DML on new tenant tables;
-- explicit too, so this doesn't depend on which role ran the migration.
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.attachment_uploads TO app_user;
