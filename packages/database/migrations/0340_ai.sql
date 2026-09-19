-- 0340_ai: AI assistant — Ask Your CRM (spec 34-ai-assistant, P0).
--
-- THREE tables, one job each:
--
--   ai_conversations  a chat thread, owned by one user (user_id). Personal:
--                     the domain service refuses to read another user's
--                     thread — see packages/crm/src/ai-assistant/access.ts.
--   ai_messages       the transcript: questions, answers, the model's tool
--                     calls and the tool results, so the UI can show *why*
--                     an answer says what it says (spec 34 §3).
--   ai_runs           accounting + attribution: provider, model, tokens,
--                     latency, cost and outcome for one answered question.
--
-- WHY A RUN IS NOT A MESSAGE
-- One question can cost several provider round-trips (ask -> tool call ->
-- tool result -> answer) and therefore several assistant messages. The run
-- is the unit of spend and attribution, the message the unit of
-- conversation. ai_messages.run_id ties every row a run produced back to
-- it, which is what makes "attributable to a model + run id" true for tool
-- calls as well as answers. audit_events rows (source = 'ai') carry the
-- same run id in record_id.
--
-- FOREIGN KEYS
-- conversation_id -> ai_conversations (id) ON DELETE CASCADE: same-module
-- FK, safe. user_id / actor_id / message_id are PLAIN uuids with indexes
-- and NO foreign key: `users` belongs to the auth foundation and this
-- module may not couple to another module's table (same rule as
-- people.company_id, 0010_people.sql). message_id additionally avoids an
-- insert-order dependency — the run row is written after its message.
--
-- COST is stored in MICRO-USD (1e-6 USD) as BIGINT, never a float: money in
-- fractional cents is exactly the case floating point gets wrong, and
-- token prices are quoted per million tokens. NULL means "no configured
-- price for this model" — an honest unknown, not a free call.
--
-- NEVER STORED HERE: no credential of any kind. ai_runs.error_message is
-- redacted at the provider (redactIntegrationSecrets) before it arrives.
--
-- Down migration:
--   DROP TABLE ai_runs; DROP TABLE ai_messages; DROP TABLE ai_conversations;

CREATE TABLE IF NOT EXISTS ai_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  -- users.id: plain column, NO foreign key (see header).
  user_id UUID,
  title VARCHAR(255) NOT NULL,
  model VARCHAR(128),
  last_message_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ai_conversations_workspace_idx
  ON ai_conversations (workspace_id);
-- The list query: this user's threads, newest activity first.
CREATE INDEX IF NOT EXISTS ai_conversations_user_idx
  ON ai_conversations (workspace_id, user_id, last_message_at);

CREATE TABLE IF NOT EXISTS ai_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  conversation_id UUID NOT NULL REFERENCES ai_conversations (id) ON DELETE CASCADE,
  role VARCHAR(16) NOT NULL,
  content TEXT NOT NULL,
  -- Attribution: which model produced this text (spec 34 §14).
  model VARCHAR(128),
  provider_id VARCHAR(64),
  -- ai_runs.id: plain column, written before the run row is closed.
  run_id UUID,
  tool_calls JSONB,
  tool_call_id VARCHAR(128),
  tool_name VARCHAR(128),
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  CONSTRAINT ai_messages_role_chk
    CHECK (role IN ('system', 'user', 'assistant', 'tool'))
);

CREATE INDEX IF NOT EXISTS ai_messages_workspace_idx
  ON ai_messages (workspace_id);
-- The transcript query: one thread in insertion order.
CREATE INDEX IF NOT EXISTS ai_messages_conversation_idx
  ON ai_messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS ai_messages_run_idx
  ON ai_messages (run_id);

CREATE TABLE IF NOT EXISTS ai_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  conversation_id UUID NOT NULL REFERENCES ai_conversations (id) ON DELETE CASCADE,
  -- Assistant message this run produced: plain column (see header).
  message_id UUID,
  -- users.id of the asker: plain column, NO foreign key.
  actor_id UUID,
  provider_id VARCHAR(64) NOT NULL,
  model VARCHAR(128) NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  -- Micro-USD (1e-6 USD). NULL = no configured price for this model.
  cost_micros BIGINT,
  outcome VARCHAR(16) NOT NULL,
  error_code VARCHAR(64),
  -- Redacted at the provider before it ever reaches this column.
  error_message TEXT,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  tool_calls JSONB,
  correlation_id VARCHAR(128),
  CONSTRAINT ai_runs_outcome_chk
    CHECK (outcome IN ('succeeded', 'failed', 'denied'))
);

CREATE INDEX IF NOT EXISTS ai_runs_workspace_idx
  ON ai_runs (workspace_id);
CREATE INDEX IF NOT EXISTS ai_runs_conversation_idx
  ON ai_runs (conversation_id, created_at);
-- Usage and cost rollups (spec 38): by workspace, by actor, over time.
CREATE INDEX IF NOT EXISTS ai_runs_usage_idx
  ON ai_runs (workspace_id, actor_id, created_at);

COMMENT ON TABLE ai_conversations IS
  'Ask-Your-CRM chat thread (spec 34). Personal to user_id: the domain service refuses cross-user reads.';
COMMENT ON TABLE ai_messages IS
  'Assistant transcript (spec 34): questions, answers, tool calls and tool results. run_id attributes every row to an ai_runs row.';
COMMENT ON TABLE ai_runs IS
  'One answered question (spec 34): provider, model, tokens, latency, cost_micros and outcome. Feeds spec 38 cost caps and usage alerts.';
COMMENT ON COLUMN ai_runs.cost_micros IS
  'Micro-USD (1e-6 USD). NULL means no configured price for this model, not a free call.';
COMMENT ON COLUMN ai_runs.error_message IS
  'Provider failure, already redacted. Never contains a credential.';
