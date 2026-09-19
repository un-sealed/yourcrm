-- 0160_reports: Reports module tables (spec 26-reports, P0).
-- A report is a SAVED DEFINITION (object, filter tree, grouping,
-- aggregation, sort, columns); results are computed on demand and scoped to
-- the calling actor, so nothing is materialised here.
-- Follows 0001_foundation.sql conventions (base columns, IF NOT EXISTS,
-- indexes beside the table).
-- owner_id / created_by / updated_by are PLAIN uuid columns with NO foreign
-- key: migrations apply in filename order and reports must not couple to
-- another module's table (same rule as people.company_id in 0010_people.sql).
-- Down migration: DROP TABLE reports.

CREATE TABLE IF NOT EXISTS reports (
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
  -- Reportable object key ("person", "company", "deal", ...). Validated
  -- against the allowlist in repositories/reports-repository.ts, never
  -- interpolated into SQL.
  object_type VARCHAR(64) NOT NULL,
  -- 'private' (owner + workspace admins) or 'shared' (whole workspace).
  visibility VARCHAR(32) NOT NULL DEFAULT 'shared',
  -- Filter tree in the @yourcrm/ui FilterBuilder encoding:
  -- { type: 'group', id, combinator: 'and'|'or', children: [...] }.
  filter JSONB,
  group_by VARCHAR(128),
  -- [{ fn: 'count'|'sum'|'avg'|'min'|'max', field?, label? }]
  aggregations JSONB,
  -- [{ field, label? }] — ordered visible columns for table output.
  columns JSONB,
  -- [{ field, direction: 'asc'|'desc' }] — same encoding as saved_views.sort.
  sort JSONB,
  row_limit INTEGER NOT NULL DEFAULT 100,
  last_run_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS reports_workspace_idx ON reports (workspace_id);
CREATE INDEX IF NOT EXISTS reports_workspace_object_idx ON reports (workspace_id, object_type);
CREATE INDEX IF NOT EXISTS reports_owner_idx ON reports (owner_id);
CREATE INDEX IF NOT EXISTS reports_visibility_idx ON reports (workspace_id, visibility);
