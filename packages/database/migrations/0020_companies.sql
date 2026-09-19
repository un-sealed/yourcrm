-- 0020_companies: Companies module tables (spec 07-companies, P0).
-- companies + company_addresses, following 0001_foundation.sql conventions
-- (base columns, IF NOT EXISTS, indexes beside tables).
-- parent_company_id is a PLAIN uuid self-column with an index and NO foreign
-- key: the hierarchy is validated in the repository, keeping the migration
-- additive and free of self-referential DDL ordering issues.
-- people.company_id (0010_people.sql) points here the same way — cross-module
-- foreign keys are added in a later integration pass.
-- Down migration: DROP TABLE IN REVERSE ORDER
-- (company_addresses, companies).

CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  owner_id UUID,
  name VARCHAR(255) NOT NULL,
  domain VARCHAR(255),
  website VARCHAR(1024),
  industry VARCHAR(128),
  size VARCHAR(64),
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  description TEXT,
  -- Plain uuid self-column (no FK): hierarchy validated in the repository.
  parent_company_id UUID
);
CREATE INDEX IF NOT EXISTS companies_workspace_idx ON companies (workspace_id);
CREATE INDEX IF NOT EXISTS companies_parent_idx ON companies (parent_company_id);
CREATE INDEX IF NOT EXISTS companies_status_idx ON companies (workspace_id, status);
CREATE INDEX IF NOT EXISTS companies_industry_idx ON companies (workspace_id, industry);
CREATE INDEX IF NOT EXISTS companies_name_idx ON companies (workspace_id, lower(name));
CREATE INDEX IF NOT EXISTS companies_domain_idx ON companies (workspace_id, lower(domain));

CREATE TABLE IF NOT EXISTS company_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  label VARCHAR(64),
  line1 VARCHAR(255),
  city VARCHAR(128),
  region VARCHAR(128),
  postal_code VARCHAR(32),
  country VARCHAR(128),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS company_addresses_company_idx ON company_addresses (company_id);
CREATE UNIQUE INDEX IF NOT EXISTS company_addresses_company_label_uidx
  ON company_addresses (company_id, lower(label)) WHERE deleted_at IS NULL;
