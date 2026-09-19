-- 0350_ai_governance: AI governance and approval queue (spec 38, P0).
--
-- "Humans remain in control of AI" is a product principle; these three
-- tables are where it is enforced. Every AI write is proposed here as DATA
-- before anything happens, and only leaves this queue through an approval:
--
--   ai_policies          per (object_type, action): require_approval |
--                        auto_apply | forbidden. Absence of a policy means
--                        REQUIRE APPROVAL — the default is deny, never
--                        auto-apply.
--   ai_action_requests   one proposed mutation: who asked (user or agent),
--                        which model + run produced it, the target object
--                        and record, the intended change as a before/after
--                        diff, a rationale, and its lifecycle status.
--   ai_action_approvals  the one human decision a request may receive.
--
-- THE TWO DATABASE-LEVEL GUARANTEES (not hygiene — the module's contract):
--
--   ai_action_approvals_request_idx UNIQUE (request_id)
--       ONE DECISION PER REQUEST, forever. Approving twice is not a race
--       the service has to referee: the second insert conflicts, the
--       repository reports created = false, and nothing is applied again.
--
--   ai_action_requests.apply_claimed_at / revert_claimed_at
--       CLAIM BEFORE APPLY. Applying is
--         UPDATE ... SET apply_claimed_at = now()
--          WHERE id = $1 AND status = 'approved' AND apply_claimed_at IS NULL
--         RETURNING *
--       so exactly one caller can ever win the row; a retried apply gets
--       zero rows back and refuses. The domain service is only reached
--       AFTER that claim succeeds, so a retry cannot double-apply.
--
-- A failed apply deliberately does NOT release its claim: at-most-once
-- beats a silent second attempt. The failure is recorded in apply_error
-- and a human must propose the action again.
--
-- POLYMORPHIC TARGET: object_type + record_id are plain columns with no
-- foreign key. This module governs every object — including custom objects
-- and objects whose modules do not exist yet — so it owns no reference to
-- another module's tables. Applying always goes through that module's own
-- domain service (AiActionApplierPort), never through SQL written here.
--
-- Down migration:
--   DROP TABLE ai_action_approvals;
--   DROP TABLE ai_action_requests;
--   DROP TABLE ai_policies;

CREATE TABLE IF NOT EXISTS ai_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  -- Target object, e.g. 'person', or '*' for "every object".
  object_type VARCHAR(64) NOT NULL DEFAULT '*',
  -- 'create' | 'update' | 'delete' | 'send_external', or '*' for all.
  action VARCHAR(32) NOT NULL DEFAULT '*',
  -- 'require_approval' (the default for anything unmatched) | 'auto_apply'
  -- | 'forbidden'. auto_apply is opt-in, per object and action, by an admin.
  mode VARCHAR(32) NOT NULL DEFAULT 'require_approval',
  description TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS ai_policies_workspace_idx ON ai_policies (workspace_id);
-- One live policy per (workspace, object, action). Soft-deleted rows are
-- excluded so a scope can be re-created after it is deleted.
CREATE UNIQUE INDEX IF NOT EXISTS ai_policies_scope_idx
  ON ai_policies (workspace_id, object_type, action)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ai_action_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  -- WHO ASKED -------------------------------------------------------------
  -- 'user' (a person used an AI feature) or 'agent' (an autonomous run).
  actor_type VARCHAR(16) NOT NULL DEFAULT 'agent',
  -- The HUMAN whose permissions the action inherits. For an agent this is
  -- its owner: an agent is never more privileged than the person behind it,
  -- exactly as a workflow runs as its owner (0190_automation.sql).
  actor_id UUID NOT NULL,
  -- Opaque id of the agent that produced the proposal. No foreign key: the
  -- agents module (spec 36) is not built yet and this module must not wait
  -- for it.
  agent_id VARCHAR(128),
  -- ATTRIBUTION -----------------------------------------------------------
  model VARCHAR(128),
  run_id VARCHAR(128),
  correlation_id VARCHAR(64),
  -- WHAT IT WOULD DO ------------------------------------------------------
  object_type VARCHAR(64) NOT NULL,
  -- NULL for a create: the record does not exist yet.
  record_id VARCHAR(128),
  action VARCHAR(32) NOT NULL,
  -- The diff. `before` is what revert restores; `after` is what apply writes.
  before JSONB,
  after JSONB,
  rationale TEXT,
  -- LIFECYCLE -------------------------------------------------------------
  -- 'pending' | 'approved' | 'rejected' | 'applied' | 'reverted' | 'expired'
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  -- Which policy decided, and what it said, at request time.
  policy_id UUID REFERENCES ai_policies (id) ON DELETE SET NULL,
  policy_mode VARCHAR(32) NOT NULL DEFAULT 'require_approval',
  -- The requesting actor's workspace role when the request was made. Kept
  -- for the audit trail only: the LIVE role is re-resolved before applying,
  -- so a demotion takes effect on anything still in the queue.
  requested_role VARCHAR(32),
  expires_at TIMESTAMPTZ,
  decided_at TIMESTAMPTZ,
  -- EXACTLY-ONCE ----------------------------------------------------------
  apply_claimed_at TIMESTAMPTZ,
  apply_claimed_by UUID,
  applied_at TIMESTAMPTZ,
  apply_result JSONB,
  apply_error TEXT,
  revert_claimed_at TIMESTAMPTZ,
  revert_claimed_by UUID,
  reverted_at TIMESTAMPTZ,
  revert_error TEXT
);
CREATE INDEX IF NOT EXISTS ai_action_requests_workspace_idx ON ai_action_requests (workspace_id);
-- The queue's hot path: "pending requests in this workspace, newest first".
CREATE INDEX IF NOT EXISTS ai_action_requests_status_idx
  ON ai_action_requests (workspace_id, status, created_at);
-- "What has AI done to this record?" — the polymorphic target lookup.
CREATE INDEX IF NOT EXISTS ai_action_requests_target_idx
  ON ai_action_requests (workspace_id, object_type, record_id);
CREATE INDEX IF NOT EXISTS ai_action_requests_run_idx ON ai_action_requests (workspace_id, run_id);
CREATE INDEX IF NOT EXISTS ai_action_requests_actor_idx ON ai_action_requests (workspace_id, actor_id);

CREATE TABLE IF NOT EXISTS ai_action_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  request_id UUID NOT NULL REFERENCES ai_action_requests (id) ON DELETE CASCADE,
  -- 'approved' | 'rejected'
  decision VARCHAR(16) NOT NULL,
  -- Always a human. An AI actor can never appear here: the service refuses
  -- a non-human approver, and the requesting actor cannot approve its own
  -- request.
  approver_id UUID NOT NULL,
  -- Both live roles at decision time. The action executes with the
  -- INTERSECTION of the two — every target permission is checked against
  -- the approver AND the requester, so neither can lend the other rights.
  approver_role VARCHAR(32),
  requester_role VARCHAR(32),
  reason TEXT,
  correlation_id VARCHAR(64)
);
CREATE INDEX IF NOT EXISTS ai_action_approvals_workspace_idx ON ai_action_approvals (workspace_id);
-- ONE DECISION PER REQUEST, FOREVER. This is what makes "approve twice"
-- impossible rather than merely unlikely.
CREATE UNIQUE INDEX IF NOT EXISTS ai_action_approvals_request_idx
  ON ai_action_approvals (request_id);
