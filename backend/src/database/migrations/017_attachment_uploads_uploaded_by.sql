-- 017 — tenant.attachment_uploads.uploaded_by (Step 2.4).
--
-- Migration 016 meant to create this table WITH uploaded_by, but the table
-- already existed since 003 (without it), so its CREATE TABLE IF NOT EXISTS
-- was a silent no-op and the column never appeared. Found 2026-10-09 by the
-- webmail live test (every upload failed with "column uploaded_by does not
-- exist"). This adds it for real.
--
-- uploaded_by: so one user can't attach another user's staged upload, even
-- within the same mailbox. Nothing wrote to this table before webmail, so
-- any row without an uploader is unusable staging data and is removed rather
-- than guessed at.

ALTER TABLE tenant.attachment_uploads
  ADD COLUMN IF NOT EXISTS uploaded_by UUID REFERENCES tenant.users(id) ON DELETE CASCADE;

DELETE FROM tenant.attachment_uploads WHERE uploaded_by IS NULL;

ALTER TABLE tenant.attachment_uploads ALTER COLUMN uploaded_by SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'tenant.attachment_uploads'::regclass AND conname = 'attachment_uploads_size_bytes_check'
  ) THEN
    ALTER TABLE tenant.attachment_uploads ADD CONSTRAINT attachment_uploads_size_bytes_check CHECK (size_bytes >= 0);
  END IF;
END $$;
