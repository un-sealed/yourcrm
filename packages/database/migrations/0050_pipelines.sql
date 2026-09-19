-- 0050_pipelines: Pipelines module tables (spec 10-pipelines, P0).
-- pipelines + pipeline_stages, following 0001_foundation.sql conventions
-- (base columns, IF NOT EXISTS, indexes beside tables).
-- pipeline_stages.pipeline_id is a same-module FK (safe: both tables are
-- created in this file). deals.pipeline_id / deals.stage_id point here as
-- PLAIN uuid columns with no FK — deals is created earlier (0040_deals.sql)
-- and is owned by another module.
-- Default pipeline rows are workspace-scoped and therefore seeded at runtime
-- by `ensureDefaultPipeline()`, not by this migration.
-- Down migration: DROP TABLE IN REVERSE ORDER
-- (pipeline_stages, pipelines).

CREATE TABLE IF NOT EXISTS pipelines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  owner_id UUID,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  is_default BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS pipelines_workspace_idx ON pipelines (workspace_id);
CREATE INDEX IF NOT EXISTS pipelines_status_idx ON pipelines (workspace_id, status);

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  pipeline_id UUID NOT NULL REFERENCES pipelines (id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  color VARCHAR(32),
  position INTEGER NOT NULL DEFAULT 0,
  probability INTEGER NOT NULL DEFAULT 0,
  is_won BOOLEAN NOT NULL DEFAULT FALSE,
  is_lost BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS pipeline_stages_pipeline_idx ON pipeline_stages (pipeline_id);
CREATE INDEX IF NOT EXISTS pipeline_stages_position_idx ON pipeline_stages (pipeline_id, position);
