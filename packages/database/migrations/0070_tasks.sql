-- 0070_tasks: Tasks module tables (spec 12-tasks, P0).
-- tasks, following 0001_foundation.sql conventions (base columns,
-- IF NOT EXISTS, indexes beside tables).
-- person_id / company_id / deal_id are PLAIN uuid columns with indexes and
-- NO foreign keys: those tables are owned by other modules (same rule as
-- people.company_id); cross-module FKs land in a later integration pass.
-- assignee_id is a plain uuid too (drives the "My tasks" filter) and is not
-- constrained here, matching owner_id in the base column set.
-- Completion is `status = 'completed'` plus completed_at; reopening clears
-- both.
-- Down migration: DROP TABLE IF EXISTS tasks.

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  owner_id UUID,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'open',
  priority VARCHAR(32) NOT NULL DEFAULT 'medium',
  due_date TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  assignee_id UUID,
  -- Cross-module references (plain uuid, no FK — see header).
  person_id UUID,
  company_id UUID,
  deal_id UUID
);
CREATE INDEX IF NOT EXISTS tasks_workspace_idx ON tasks (workspace_id);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks (workspace_id, status);
CREATE INDEX IF NOT EXISTS tasks_priority_idx ON tasks (workspace_id, priority);
CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks (workspace_id, assignee_id);
CREATE INDEX IF NOT EXISTS tasks_due_idx ON tasks (workspace_id, due_date);
CREATE INDEX IF NOT EXISTS tasks_person_idx ON tasks (person_id);
CREATE INDEX IF NOT EXISTS tasks_company_idx ON tasks (company_id);
CREATE INDEX IF NOT EXISTS tasks_deal_idx ON tasks (deal_id);
