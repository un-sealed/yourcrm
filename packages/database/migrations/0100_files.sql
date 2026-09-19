-- 0100_files: Files module tables (spec 29-files, P0).
-- files, following 0001_foundation.sql conventions (base columns,
-- IF NOT EXISTS, indexes beside tables).
-- One metadata row per stored object: bytes live in S3/MinIO
-- (@yourcrm/storage), Postgres keeps metadata only.
-- subject_type + subject_id are PLAIN polymorphic columns with an index and
-- NO foreign key (same rule as taggables.record_id): subject_type names the
-- attached record's module (person | company | deal) and subject_id is that
-- record's uuid.
-- Down migration: DROP TABLE IF EXISTS files.

CREATE TABLE IF NOT EXISTS files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  owner_id UUID,
  file_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(128),
  size_bytes INTEGER NOT NULL DEFAULT 0,
  storage_key TEXT NOT NULL,
  -- Polymorphic attachment: plain columns, NO foreign key (see header).
  subject_type VARCHAR(64),
  subject_id UUID,
  description TEXT
);
CREATE INDEX IF NOT EXISTS files_workspace_idx ON files (workspace_id);
CREATE INDEX IF NOT EXISTS files_subject_idx ON files (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS files_mime_idx ON files (workspace_id, mime_type);
CREATE INDEX IF NOT EXISTS files_name_idx ON files (workspace_id, lower(file_name));
