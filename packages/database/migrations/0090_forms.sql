-- 0090_forms: Forms module tables (spec 23-forms, P0).
-- forms + form_fields + form_submissions, following 0001_foundation.sql
-- conventions (base columns, IF NOT EXISTS, indexes beside tables).
-- form_fields.form_id and form_submissions.form_id are same-module FKs
-- (safe: all three tables are created in this file).
-- form_submissions.lead_id is a PLAIN uuid column with an index and NO
-- foreign key — leads is owned by another module (same rule as
-- people.company_id); it stays null until the lead-creation pass lands.
-- Down migration: DROP TABLE IN REVERSE ORDER
-- (form_submissions, form_fields, forms).

CREATE TABLE IF NOT EXISTS forms (
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
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  -- Unguessable share token used by the unauthenticated submit endpoint.
  public_id VARCHAR(64) NOT NULL,
  success_message TEXT
);
CREATE INDEX IF NOT EXISTS forms_workspace_idx ON forms (workspace_id);
CREATE INDEX IF NOT EXISTS forms_status_idx ON forms (workspace_id, status);
CREATE INDEX IF NOT EXISTS forms_name_idx ON forms (workspace_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS forms_public_id_uidx ON forms (public_id);

CREATE TABLE IF NOT EXISTS form_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  form_id UUID NOT NULL REFERENCES forms (id) ON DELETE CASCADE,
  label VARCHAR(255) NOT NULL,
  field_type VARCHAR(32) NOT NULL DEFAULT 'text',
  required BOOLEAN NOT NULL DEFAULT FALSE,
  position INTEGER NOT NULL DEFAULT 0,
  placeholder VARCHAR(255),
  options JSONB,
  help_text TEXT
);
CREATE INDEX IF NOT EXISTS form_fields_form_idx ON form_fields (form_id);
CREATE INDEX IF NOT EXISTS form_fields_form_position_idx ON form_fields (form_id, position);

CREATE TABLE IF NOT EXISTS form_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  form_id UUID NOT NULL REFERENCES forms (id) ON DELETE CASCADE,
  -- "values" is a reserved word in PostgreSQL, so it is quoted here.
  "values" JSONB NOT NULL DEFAULT '{}'::jsonb,
  submitter_email VARCHAR(320),
  -- Cross-module reference to leads (plain uuid, no FK — see header).
  lead_id UUID,
  ip_hash VARCHAR(128),
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS form_submissions_form_idx ON form_submissions (form_id);
CREATE INDEX IF NOT EXISTS form_submissions_workspace_idx ON form_submissions (workspace_id);
CREATE INDEX IF NOT EXISTS form_submissions_lead_idx ON form_submissions (lead_id);
