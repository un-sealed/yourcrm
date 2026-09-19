-- 0060_activities: Activities module tables (spec 11-activities, P0).
-- activities, following 0001_foundation.sql conventions (base columns,
-- IF NOT EXISTS, indexes beside tables).
-- subject_type + subject_id are PLAIN polymorphic columns with an index and
-- NO foreign key (same rule as taggables.record_id): subject_type names the
-- owning module record (person | company | deal | lead) and subject_id is
-- that record's uuid. This is the reusable timeline seam — other modules
-- query by (subject_type, subject_id).
-- Down migration: DROP TABLE IF EXISTS activities.

CREATE TABLE IF NOT EXISTS activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  owner_id UUID,
  title VARCHAR(255) NOT NULL,
  type VARCHAR(32) NOT NULL DEFAULT 'note',
  -- Polymorphic association: plain columns, NO foreign key (see header).
  subject_type VARCHAR(64),
  subject_id UUID,
  body TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'open',
  due_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS activities_workspace_idx ON activities (workspace_id);
CREATE INDEX IF NOT EXISTS activities_type_idx ON activities (workspace_id, type);
CREATE INDEX IF NOT EXISTS activities_status_idx ON activities (workspace_id, status);
CREATE INDEX IF NOT EXISTS activities_subject_idx ON activities (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS activities_title_idx ON activities (workspace_id, lower(title));
