-- 0040_deals: Deals module tables (spec 09-deals, P0).
-- deals, following 0001_foundation.sql conventions (base columns,
-- IF NOT EXISTS, indexes beside tables).
-- pipeline_id / stage_id are PLAIN uuid columns with indexes and NO foreign
-- keys: the pipelines tables are created later (0050_pipelines.sql), so a FK
-- here would fail on a clean database. person_id / company_id are likewise
-- plain uuid references to tables owned by other modules (same rule as
-- people.company_id); cross-module FKs land in a later integration pass.
-- `stage` is the kanban grouping key (stable machine string); amount is
-- NUMERIC(14,2) and weighted value (amount * probability / 100) is derived,
-- never stored.
-- Down migration: DROP TABLE IF EXISTS deals.

CREATE TABLE IF NOT EXISTS deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  owner_id UUID,
  name VARCHAR(255) NOT NULL,
  amount NUMERIC(14, 2),
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  -- Cross-module references (plain uuid, no FK — see header).
  pipeline_id UUID,
  stage_id UUID,
  stage VARCHAR(64) NOT NULL DEFAULT 'qualification',
  probability INTEGER,
  expected_close_date DATE,
  person_id UUID,
  company_id UUID,
  close_reason VARCHAR(255),
  notes TEXT
);
CREATE INDEX IF NOT EXISTS deals_workspace_idx ON deals (workspace_id);
CREATE INDEX IF NOT EXISTS deals_stage_idx ON deals (workspace_id, stage);
CREATE INDEX IF NOT EXISTS deals_pipeline_idx ON deals (pipeline_id);
CREATE INDEX IF NOT EXISTS deals_stage_ref_idx ON deals (stage_id);
CREATE INDEX IF NOT EXISTS deals_person_idx ON deals (person_id);
CREATE INDEX IF NOT EXISTS deals_company_idx ON deals (company_id);
CREATE INDEX IF NOT EXISTS deals_close_date_idx ON deals (workspace_id, expected_close_date);
