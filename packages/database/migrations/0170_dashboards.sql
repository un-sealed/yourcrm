-- 0170_dashboards: Dashboards module tables (spec 27-dashboards, P0).
-- dashboards + dashboard_widgets, following 0010_people.sql conventions
-- (base columns, IF NOT EXISTS, indexes beside tables).
-- report_id is a PLAIN uuid column with an index and NO foreign key: the
-- reports module (spec 26-reports, slot 0160) is owned by a different
-- module agent and its table does not exist in this worktree (same rule as
-- people.company_id). dashboard_widgets.dashboard_id IS a foreign key —
-- same-module reference, defined in this same file.
-- Down migration: DROP TABLE IN REVERSE ORDER (dashboard_widgets, dashboards).

CREATE TABLE IF NOT EXISTS dashboards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  owner_id UUID,
  name VARCHAR(255) NOT NULL,
  description TEXT
);
CREATE INDEX IF NOT EXISTS dashboards_workspace_idx ON dashboards (workspace_id);
CREATE INDEX IF NOT EXISTS dashboards_name_idx ON dashboards (workspace_id, lower(name));

CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  dashboard_id UUID NOT NULL REFERENCES dashboards (id) ON DELETE CASCADE,
  type VARCHAR(32) NOT NULL DEFAULT 'metric',
  title VARCHAR(255) NOT NULL,
  position_x INTEGER NOT NULL DEFAULT 0,
  position_y INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 4,
  height INTEGER NOT NULL DEFAULT 2,
  -- Cross-module reference (plain uuid, NO foreign key — see header).
  report_id UUID,
  config JSONB
);
CREATE INDEX IF NOT EXISTS dashboard_widgets_dashboard_idx ON dashboard_widgets (dashboard_id);
CREATE INDEX IF NOT EXISTS dashboard_widgets_workspace_idx ON dashboard_widgets (workspace_id);
CREATE INDEX IF NOT EXISTS dashboard_widgets_report_idx ON dashboard_widgets (report_id);
