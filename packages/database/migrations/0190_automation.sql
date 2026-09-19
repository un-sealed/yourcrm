-- 0190_automation: Workflow automation engine (spec 25-automation, P0).
--
-- A workflow is a stored reaction to a domain event:
--   trigger (a @yourcrm/events event name)
--     -> conditions (FilterTree, the one filter model in the product)
--     -> ordered actions (create task / update field / add tag / notify)
--
-- Three tables, all created here:
--   workflows          the definition, enabled/disabled per workspace
--   workflow_runs      one row per (workflow, triggering event)
--   workflow_run_steps one row per (run, action index)
--
-- The two UNIQUE indexes are the engine's correctness guarantees, not
-- hygiene:
--   workflow_runs_event_idx (workflow_id, trigger_event_id)
--       IDEMPOTENCY. Event redelivery cannot create a second run, so a
--       redelivered event cannot apply the same actions twice.
--   workflow_run_steps_index_idx (run_id, step_index)
--       PER-STEP CLAIM. A retried job re-claims each step and skips the
--       ones already attempted, so a retry never re-applies an action.
--
-- workflow_runs.depth is the LOOP PROTECTION counter: actions emit events,
-- events can trigger workflows, and each generation increments depth. The
-- domain service refuses to dispatch past WORKFLOW_MAX_CASCADE_DEPTH and
-- records a 'skipped' run instead, so a self-triggering workflow stops.
--
-- Foreign keys point only at tables created by this migration (plus the
-- self-reference on parent_run_id). owner_id / actor_id / created_by /
-- updated_by stay PLAIN uuid columns with no foreign key — the same rule
-- 0160_reports.sql and 0170_dashboards.sql follow.
--
-- Down migration:
--   DROP TABLE workflow_run_steps; DROP TABLE workflow_runs; DROP TABLE workflows;

CREATE TABLE IF NOT EXISTS workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  -- Actions execute AS this actor. Permission inheritance is resolved from
  -- this user's live workspace role at run time, never snapshotted here.
  owner_id UUID,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  -- Domain event name, e.g. 'person.created'. Validated against the
  -- allowlist derived from @yourcrm/events in the domain layer
  -- (WORKFLOW_TRIGGER_EVENTS); workflow.* events are deliberately NOT
  -- triggerable, which is a second layer of loop protection.
  -- EXTENSION POINT: cron/schedule triggers (P1) add a nullable
  -- trigger_schedule column plus a repeatable job on the same queue seam.
  trigger_event VARCHAR(64) NOT NULL,
  -- Optional narrowing by entity type when one event covers many objects.
  trigger_entity_type VARCHAR(64),
  -- FilterTree in the @yourcrm/ui FilterBuilder encoding:
  -- { type: 'group', id, combinator: 'and'|'or', children: [...] }
  conditions JSONB,
  -- Ordered [{ type: 'create_task'|'update_field'|'add_tag'|'notify', ... }]
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- 'disabled' (default — a new workflow never fires until published) or
  -- 'enabled'. Enabling requires the run_automation permission.
  status VARCHAR(32) NOT NULL DEFAULT 'disabled',
  last_run_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS workflows_workspace_idx ON workflows (workspace_id);
CREATE INDEX IF NOT EXISTS workflows_trigger_idx ON workflows (workspace_id, trigger_event, status);
CREATE INDEX IF NOT EXISTS workflows_owner_idx ON workflows (owner_id);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  workflow_id UUID NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
  -- Envelope eventId of the triggering event: the idempotency key.
  trigger_event_id VARCHAR(128) NOT NULL,
  trigger_event VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64),
  entity_id VARCHAR(128),
  -- Frozen copy of the triggering envelope, for replay and debugging.
  trigger_payload JSONB,
  -- 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped'
  status VARCHAR(32) NOT NULL DEFAULT 'queued',
  -- Cascade generation: 0 for a user-caused event, +1 per automation hop.
  depth INTEGER NOT NULL DEFAULT 0,
  -- Self-reference: the run whose action emitted the triggering event.
  parent_run_id UUID REFERENCES workflow_runs (id) ON DELETE SET NULL,
  actor_id UUID,
  actor_role VARCHAR(32),
  correlation_id VARCHAR(64),
  error TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS workflow_runs_workspace_idx ON workflow_runs (workspace_id);
CREATE INDEX IF NOT EXISTS workflow_runs_workflow_idx ON workflow_runs (workflow_id, created_at);
CREATE INDEX IF NOT EXISTS workflow_runs_status_idx ON workflow_runs (workspace_id, status);
CREATE INDEX IF NOT EXISTS workflow_runs_parent_idx ON workflow_runs (parent_run_id);
-- IDEMPOTENCY: one run per (workflow, triggering event), forever.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_event_idx
  ON workflow_runs (workflow_id, trigger_event_id);

CREATE TABLE IF NOT EXISTS workflow_run_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  run_id UUID NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
  -- Position in the definition's actions array.
  step_index INTEGER NOT NULL,
  action_type VARCHAR(64) NOT NULL,
  -- 'running' | 'succeeded' | 'failed' | 'skipped'
  status VARCHAR(32) NOT NULL DEFAULT 'running',
  -- What the action did, e.g. { "taskId": "..." }. Never secrets.
  result JSONB,
  error TEXT,
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS workflow_run_steps_workspace_idx ON workflow_run_steps (workspace_id);
-- PER-STEP CLAIM (also the ordered lookup index for a run's steps).
CREATE UNIQUE INDEX IF NOT EXISTS workflow_run_steps_index_idx
  ON workflow_run_steps (run_id, step_index);
