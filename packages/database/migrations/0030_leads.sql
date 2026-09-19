-- 0030_leads: Leads module tables (spec 08-leads, P0).
-- leads, following 0001_foundation.sql conventions (base columns,
-- IF NOT EXISTS, indexes beside tables).
-- person_id / company_id / deal_id are PLAIN uuid columns with indexes and
-- NO foreign keys: those tables are owned by other modules (people/companies
-- exist already, deals does not yet) and cross-module foreign keys are added
-- in a later integration pass (same rule as people.company_id).
-- Down migration: DROP TABLE IF EXISTS leads.

CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  owner_id UUID,
  first_name VARCHAR(255) NOT NULL,
  last_name VARCHAR(255),
  email VARCHAR(320),
  phone VARCHAR(64),
  company_name VARCHAR(255),
  title VARCHAR(255),
  source VARCHAR(32) NOT NULL DEFAULT 'manual',
  status VARCHAR(32) NOT NULL DEFAULT 'new',
  score INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  -- Cross-module conversion targets (plain uuid, no FK — see header).
  person_id UUID,
  company_id UUID,
  deal_id UUID
);
CREATE INDEX IF NOT EXISTS leads_workspace_idx ON leads (workspace_id);
CREATE INDEX IF NOT EXISTS leads_status_idx ON leads (workspace_id, status);
CREATE INDEX IF NOT EXISTS leads_source_idx ON leads (workspace_id, source);
CREATE INDEX IF NOT EXISTS leads_person_idx ON leads (person_id);
CREATE INDEX IF NOT EXISTS leads_company_idx ON leads (company_id);
CREATE INDEX IF NOT EXISTS leads_deal_idx ON leads (deal_id);
