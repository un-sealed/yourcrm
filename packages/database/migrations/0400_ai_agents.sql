-- 0400_ai_agents: AI agents and agent runs (spec 36-ai-agents, P0).
--
-- An agent is a NAMED, SCOPED, TRIGGERABLE LLM LOOP. Two tables:
--
--   ai_agents      the definition: instructions (the system prompt), the
--                  model, the ALLOWLISTED subset of the assistant's
--                  read-only tools it may call, its trigger (manual, or a
--                  domain event), its OWNER — whose live permissions every
--                  run inherits — and its hard budgets.
--   ai_agent_runs  one execution: which event woke it, how many provider
--                  steps and tool calls it spent, how many changes it
--                  PROPOSED, the tokens, the latency, the cost and the
--                  outcome.
--
-- READS HAPPEN. WRITES NEVER DO.
-- There is deliberately no "agent action" table here. An agent cannot
-- change a record: it proposes, and a proposal is an ai_action_requests
-- row owned by the approval queue (0350_ai_governance.sql), which a human
-- must approve before the owning module's domain service applies it.
-- ai_agent_runs.step_log carries the request ids, so one run links to
-- everything it asked for without this module owning a second queue — or a
-- second place to enforce "a human decides".
--
-- THE DATABASE-LEVEL GUARANTEE (not hygiene — the module's contract):
--
--   ai_agent_runs_event_idx UNIQUE (agent_id, trigger_event_id)
--       ONE RUN PER (AGENT, TRIGGERING EVENT), forever. Event redelivery
--       is not a race the service has to referee: the second insert
--       conflicts, the repository reports created = false, nothing is
--       enqueued, and the agent does not spend the tokens — or queue the
--       same proposal — twice. A manual run supplies a synthetic
--       'manual:<uuid>' key so it can never collide, while a retried job
--       still resumes the same row.
--
-- BOUNDED LOOPS live in two places on purpose: max_steps / max_tool_calls
-- / max_total_tokens are CHECK-constrained here to the ceilings the domain
-- layer enforces (AI_AGENT_MAX_*_CEILING), and the service clamps the
-- stored value again at execution time. A hand-edited row cannot buy an
-- unbounded loop, and a run that hits a ceiling terminates with status
-- 'exhausted' — a first-class outcome, not a flavour of 'failed'.
--
-- LOOP PROTECTION across runs: depth / parent_run_id, exactly as
-- workflow_runs does it. An approved proposal is applied through the
-- owning module's service and emits that module's event carrying
-- 'agentrun:<runId>', which can wake another agent; the dispatcher derives
-- the next depth from it and records anything past
-- AI_AGENT_MAX_CASCADE_DEPTH as 'skipped' without enqueuing it.
--
-- COST is stored in MICRO-USD (1e-6 USD) as BIGINT, never a float, and
-- NULL means "no configured price for this model" — an honest unknown, not
-- a free call. Same convention as ai_runs (0340_ai.sql).
--
-- FOREIGN KEYS: agent_id -> ai_agents (id) ON DELETE CASCADE and
-- parent_run_id -> ai_agent_runs (id) are same-module references.
-- owner_id / actor_id / created_by / updated_by are PLAIN uuids with no
-- foreign key: `users` belongs to the auth foundation and this module owns
-- no reference into another module's tables (same rule as workflows,
-- 0190_automation.sql).
--
-- NEVER STORED HERE: no credential, and no tool payloads. step_log records
-- tool names, access ('read' | 'propose'), outcomes, durations and
-- proposal request ids only. error is redacted (redactIntegrationSecrets)
-- before it reaches this table.
--
-- Down migration:
--   DROP TABLE ai_agent_runs; DROP TABLE ai_agents;

CREATE TABLE IF NOT EXISTS ai_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  -- users.id of the person this agent RUNS AS: plain column, NO foreign
  -- key (see header). The owner's role is re-resolved live per run.
  owner_id UUID,
  name VARCHAR(160) NOT NULL,
  description TEXT,
  -- The system prompt. An agent with no instructions is not an agent.
  instructions TEXT NOT NULL,
  -- NULL takes the provider's default model.
  model VARCHAR(128),
  -- Allowlisted tool names, e.g. ["crm_query", "crm_propose_change"].
  -- A name the registry does not offer is refused at save time and
  -- ignored at run time: scope can only ever shrink.
  tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  trigger_type VARCHAR(16) NOT NULL DEFAULT 'manual',
  -- A @yourcrm/events event name (the automation engine's allowlist).
  trigger_event VARCHAR(128),
  trigger_entity_type VARCHAR(64),
  status VARCHAR(16) NOT NULL DEFAULT 'disabled',
  max_steps INTEGER NOT NULL DEFAULT 6,
  max_tool_calls INTEGER NOT NULL DEFAULT 12,
  max_total_tokens INTEGER NOT NULL DEFAULT 60000,
  last_run_at TIMESTAMPTZ,
  CONSTRAINT ai_agents_status_chk
    CHECK (status IN ('disabled', 'enabled')),
  CONSTRAINT ai_agents_trigger_type_chk
    CHECK (trigger_type IN ('manual', 'event')),
  CONSTRAINT ai_agents_event_trigger_chk
    CHECK (trigger_type <> 'event' OR trigger_event IS NOT NULL),
  -- The budget ceilings, restated where they cannot be argued with.
  CONSTRAINT ai_agents_max_steps_chk CHECK (max_steps BETWEEN 1 AND 12),
  CONSTRAINT ai_agents_max_tool_calls_chk CHECK (max_tool_calls BETWEEN 1 AND 24),
  CONSTRAINT ai_agents_max_total_tokens_chk CHECK (max_total_tokens BETWEEN 1 AND 200000)
);

CREATE INDEX IF NOT EXISTS ai_agents_workspace_idx
  ON ai_agents (workspace_id);
-- The dispatcher's query: enabled agents listening to one event.
CREATE INDEX IF NOT EXISTS ai_agents_trigger_idx
  ON ai_agents (workspace_id, trigger_event, status);
CREATE INDEX IF NOT EXISTS ai_agents_owner_idx
  ON ai_agents (workspace_id, owner_id);
-- One live agent per name, so a run history is attributable to a name.
CREATE UNIQUE INDEX IF NOT EXISTS ai_agents_name_idx
  ON ai_agents (workspace_id, name)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ai_agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  agent_id UUID NOT NULL REFERENCES ai_agents (id) ON DELETE CASCADE,
  trigger_type VARCHAR(16) NOT NULL,
  trigger_event VARCHAR(128),
  -- IDEMPOTENCY KEY: the triggering event's envelope id, or 'manual:<uuid>'.
  trigger_event_id VARCHAR(128) NOT NULL,
  trigger_payload JSONB,
  -- The task text of a manual run. NULL for event-triggered runs.
  input TEXT,
  entity_type VARCHAR(64),
  entity_id UUID,
  -- The OWNER this run inherited from: plain column, NO foreign key.
  actor_id UUID,
  -- That owner's role as resolved LIVE at execution time.
  actor_role VARCHAR(32),
  status VARCHAR(16) NOT NULL DEFAULT 'queued',
  -- Loop protection, as on workflow_runs.
  depth INTEGER NOT NULL DEFAULT 0,
  parent_run_id UUID REFERENCES ai_agent_runs (id) ON DELETE SET NULL,
  -- Provider round-trips this run spent.
  steps INTEGER NOT NULL DEFAULT 0,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  -- Changes PROPOSED to the approval queue. Never changes applied.
  proposal_count INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  -- Micro-USD (1e-6 USD). NULL = no configured price for this model.
  cost_micros BIGINT,
  provider_id VARCHAR(64),
  model VARCHAR(128),
  -- The agent's final answer, truncated. Never a tool payload.
  summary TEXT,
  -- Per-call trace: name, access, outcome, duration, proposal request id.
  step_log JSONB,
  error_code VARCHAR(64),
  -- Redacted before it arrives. Never contains a credential.
  error TEXT,
  correlation_id VARCHAR(128),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  CONSTRAINT ai_agent_runs_status_chk
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'exhausted', 'denied', 'skipped')),
  CONSTRAINT ai_agent_runs_trigger_type_chk
    CHECK (trigger_type IN ('manual', 'event')),
  CONSTRAINT ai_agent_runs_depth_chk CHECK (depth >= 0)
);

CREATE INDEX IF NOT EXISTS ai_agent_runs_workspace_idx
  ON ai_agent_runs (workspace_id);
CREATE INDEX IF NOT EXISTS ai_agent_runs_agent_idx
  ON ai_agent_runs (agent_id, created_at);
CREATE INDEX IF NOT EXISTS ai_agent_runs_status_idx
  ON ai_agent_runs (workspace_id, status, created_at);
-- Usage and cost rollups: by workspace, by owner, over time.
CREATE INDEX IF NOT EXISTS ai_agent_runs_usage_idx
  ON ai_agent_runs (workspace_id, actor_id, created_at);
-- IDEMPOTENCY: one run per (agent, triggering event), forever.
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_runs_event_idx
  ON ai_agent_runs (agent_id, trigger_event_id);

COMMENT ON TABLE ai_agents IS
  'AI agent definition (spec 36): instructions, model, allowlisted read tools, trigger, owner and hard budgets. Runs as owner_id with that user''s LIVE role.';
COMMENT ON TABLE ai_agent_runs IS
  'One AI agent execution (spec 36): trigger, steps, tool calls, proposals, tokens, latency, cost_micros and outcome. UNIQUE (agent_id, trigger_event_id) makes event redelivery a no-op.';
COMMENT ON COLUMN ai_agents.tools IS
  'Allowlisted tool names. Reads execute directly; crm_propose_change only queues an ai_action_requests row for human approval.';
COMMENT ON COLUMN ai_agent_runs.proposal_count IS
  'Changes proposed to the approval queue (0350). An agent never applies a change itself.';
COMMENT ON COLUMN ai_agent_runs.cost_micros IS
  'Micro-USD (1e-6 USD). NULL means no configured price for this model, not a free call.';
COMMENT ON COLUMN ai_agent_runs.status IS
  'exhausted = a budget ceiling stopped the loop; it is not an error. denied = the owner''s live role refused the run.';
