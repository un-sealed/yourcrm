-- 0120_import-export: Import / Export module tables
-- (spec 30-import-export, P0 CSV only), following 0001_foundation.sql
-- conventions (base columns, IF NOT EXISTS, indexes beside tables).
-- import_jobs / export_jobs are generic over `object_type` (person, company,
-- lead, ...): that is a PLAIN varchar naming the target module, never a
-- foreign key — the target tables are owned by other modules and may not
-- exist yet (same rule as taggables.object_type).
-- Mapping payloads, filter snapshots and row-error previews live in JSONB so
-- the P0 slice needs no extra tables; dedicated ImportMapping /
-- ImportRowError / MigrationJob tables are deferred to a later pass.
-- Down migration: DROP TABLE IN REVERSE ORDER
-- (export_jobs, import_jobs).

CREATE TABLE IF NOT EXISTS import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  owner_id UUID,
  -- Generic target object type (plain value, no FK — see header).
  object_type VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  mode VARCHAR(32) NOT NULL DEFAULT 'create',
  -- P0 is CSV only; excel/json are deferred.
  format VARCHAR(16) NOT NULL DEFAULT 'csv',
  file_name VARCHAR(255),
  -- Column mapping: source header -> target field.
  mapping JSONB,
  total_rows INTEGER NOT NULL DEFAULT 0,
  processed_rows INTEGER NOT NULL DEFAULT 0,
  succeeded_rows INTEGER NOT NULL DEFAULT 0,
  failed_rows INTEGER NOT NULL DEFAULT 0,
  skipped_rows INTEGER NOT NULL DEFAULT 0,
  dry_run BOOLEAN NOT NULL DEFAULT FALSE,
  -- Dry-run / execution row-error preview (JSON array).
  errors JSONB,
  error_report TEXT
);
CREATE INDEX IF NOT EXISTS import_jobs_workspace_idx ON import_jobs (workspace_id);
CREATE INDEX IF NOT EXISTS import_jobs_status_idx ON import_jobs (workspace_id, status);
CREATE INDEX IF NOT EXISTS import_jobs_object_idx ON import_jobs (workspace_id, object_type);

CREATE TABLE IF NOT EXISTS export_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  owner_id UUID,
  -- Generic target object type (plain value, no FK — see header).
  object_type VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  -- P0 is CSV only; excel/json are deferred.
  format VARCHAR(16) NOT NULL DEFAULT 'csv',
  file_name VARCHAR(255),
  -- Structured filter snapshot used for the export.
  filters JSONB,
  total_rows INTEGER NOT NULL DEFAULT 0,
  -- Temporary file location (bytes live in S3/MinIO per architecture).
  file_path TEXT
);
CREATE INDEX IF NOT EXISTS export_jobs_workspace_idx ON export_jobs (workspace_id);
CREATE INDEX IF NOT EXISTS export_jobs_status_idx ON export_jobs (workspace_id, status);
CREATE INDEX IF NOT EXISTS export_jobs_object_idx ON export_jobs (workspace_id, object_type);
