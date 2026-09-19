-- 0010_people: People module tables (spec 06-people, P0).
-- people + person_emails + person_phones, following 0001_foundation.sql
-- conventions (base columns, IF NOT EXISTS, indexes beside tables).
-- company_id is a PLAIN uuid column with an index and NO foreign key: the
-- companies table does not exist yet (same rule as taggables.record_id).
-- Down migration: DROP TABLE IN REVERSE ORDER
-- (person_phones, person_emails, people).

CREATE TABLE IF NOT EXISTS people (
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
  title VARCHAR(255),
  company_id UUID,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  preferred_channel VARCHAR(32),
  notes TEXT
);
CREATE INDEX IF NOT EXISTS people_workspace_idx ON people (workspace_id);
CREATE INDEX IF NOT EXISTS people_company_idx ON people (company_id);
CREATE INDEX IF NOT EXISTS people_status_idx ON people (workspace_id, status);
CREATE INDEX IF NOT EXISTS people_name_idx ON people (workspace_id, lower(last_name), lower(first_name));

CREATE TABLE IF NOT EXISTS person_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  person_id UUID NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  email VARCHAR(320) NOT NULL,
  label VARCHAR(64),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS person_emails_person_idx ON person_emails (person_id);
CREATE UNIQUE INDEX IF NOT EXISTS person_emails_person_email_uidx
  ON person_emails (person_id, lower(email)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS person_phones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  person_id UUID NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  phone VARCHAR(64) NOT NULL,
  label VARCHAR(64),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS person_phones_person_idx ON person_phones (person_id);
CREATE UNIQUE INDEX IF NOT EXISTS person_phones_person_phone_uidx
  ON person_phones (person_id, phone) WHERE deleted_at IS NULL;
