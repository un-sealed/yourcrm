import { sql } from "drizzle-orm"
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core"
import { baseColumns, ownerColumn, uuid, workspaceColumn } from "./base"

/**
 * AI agent tables (spec 36-ai-agents, P0). Migration `0400_ai_agents.sql`.
 *
 * An agent is a NAMED, SCOPED, TRIGGERABLE LLM LOOP, and these two tables
 * are the definition and the ledger:
 *
 *  - `ai_agents`     what it is: instructions, model, the allowlisted
 *                    subset of the assistant's read tools it may call, its
 *                    trigger, its OWNER (whose permissions it inherits)
 *                    and its hard budgets.
 *  - `ai_agent_runs` what one execution did: the triggering event, how
 *                    many provider steps and tool calls it took, how many
 *                    changes it PROPOSED, the tokens, the latency, the
 *                    cost and the outcome.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * There is no "agent action" table. An agent never changes a record, so
 * there is nothing to record here: a proposed change is an
 * `ai_action_requests` row owned by spec 38's approval queue (migration
 * 0350), and `ai_agent_runs.step_log` carries the request ids so one run
 * links to everything it asked for. Duplicating the queue would mean two
 * places to look for "what did AI want to do", and two places to enforce
 * "a human decides".
 *
 * THE UNIQUE INDEX IS LOAD-BEARING
 * --------------------------------
 * `ai_agent_runs_event_idx (agent_id, trigger_event_id)` is the
 * IDEMPOTENCY key: a redelivered domain event cannot create a second run,
 * so an agent cannot be executed twice for one event — which for an LLM
 * agent means it cannot spend the tokens twice or queue the same proposal
 * twice. Manual runs get a synthetic `manual:<uuid>` key, so they never
 * collide and a retried job resumes the same run.
 *
 * `depth` / `parent_run_id` carry the LOOP PROTECTION counter, exactly as
 * `workflow_runs` does: an approved proposal emits the owning module's
 * event carrying `agentrun:<runId>`, which can wake another agent. The
 * domain service refuses to dispatch past `AI_AGENT_MAX_CASCADE_DEPTH`.
 *
 * FOREIGN KEYS
 * ------------
 * `ai_agent_runs.agent_id` references `ai_agents (id)` — same-module FK,
 * with cascade delete — and `parent_run_id` is a self-reference.
 * `owner_id`, `actor_id` and `created_by` are PLAIN uuids with no foreign
 * key: `users` belongs to the auth foundation, and this module owns no
 * reference into another module's tables (same rule as `workflows`).
 *
 * NEVER STORED HERE
 * -----------------
 * No credential, and no tool payloads: `step_log` records tool names,
 * outcomes, durations and proposal ids only. `error` is redacted before it
 * arrives (`redactIntegrationSecrets`).
 */

export const AI_AGENT_STATUS_VALUES = ["disabled", "enabled"] as const

export type AiAgentStatus = (typeof AI_AGENT_STATUS_VALUES)[number]

export function isAiAgentStatus(value: unknown): value is AiAgentStatus {
  return typeof value === "string" && (AI_AGENT_STATUS_VALUES as readonly string[]).includes(value)
}

export const AI_AGENT_TRIGGER_TYPE_VALUES = ["manual", "event"] as const

export type AiAgentTriggerType = (typeof AI_AGENT_TRIGGER_TYPE_VALUES)[number]

export function isAiAgentTriggerType(value: unknown): value is AiAgentTriggerType {
  return (
    typeof value === "string" && (AI_AGENT_TRIGGER_TYPE_VALUES as readonly string[]).includes(value)
  )
}

/**
 * `exhausted` is a first-class outcome, not a flavour of `failed`: a run
 * that hit its step, tool-call or token ceiling did legitimate work and
 * needs a different human response from one that broke.
 */
export const AI_AGENT_RUN_STATUS_VALUES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "exhausted",
  "denied",
  "skipped",
] as const

export type AiAgentRunStatus = (typeof AI_AGENT_RUN_STATUS_VALUES)[number]

export function isAiAgentRunStatus(value: unknown): value is AiAgentRunStatus {
  return (
    typeof value === "string" && (AI_AGENT_RUN_STATUS_VALUES as readonly string[]).includes(value)
  )
}

/** The definition. Disabled until somebody with `run_ai` turns it on. */
export const aiAgents = pgTable(
  "ai_agents",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    name: varchar("name", { length: 160 }).notNull(),
    description: text("description"),
    /** The system prompt. An agent with no instructions is not an agent. */
    instructions: text("instructions").notNull(),
    /** NULL takes the provider's default model. */
    model: varchar("model", { length: 128 }),
    /**
     * Allowlisted tool names, e.g. `["crm_query", "crm_propose_change"]`.
     * A name the registry does not offer is refused at save time and
     * ignored at run time — scope can only ever shrink.
     */
    tools: jsonb("tools")
      .notNull()
      .default(sql`'[]'::jsonb`),
    triggerType: varchar("trigger_type", { length: 16 }).notNull().default("manual"),
    /** A `@yourcrm/events` event name. Required when trigger_type = event. */
    triggerEvent: varchar("trigger_event", { length: 128 }),
    triggerEntityType: varchar("trigger_entity_type", { length: 64 }),
    status: varchar("status", { length: 16 }).notNull().default("disabled"),
    /** Hard budgets, clamped again against the ceilings at execution. */
    maxSteps: integer("max_steps").notNull().default(6),
    maxToolCalls: integer("max_tool_calls").notNull().default(12),
    maxTotalTokens: integer("max_total_tokens").notNull().default(60000),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  },
  (t) => [
    index("ai_agents_workspace_idx").on(t.workspaceId),
    // The dispatcher's query: enabled agents listening to one event.
    index("ai_agents_trigger_idx").on(t.workspaceId, t.triggerEvent, t.status),
    index("ai_agents_owner_idx").on(t.workspaceId, t.ownerId),
    // One live agent per name, so a run history is attributable to a name.
    uniqueIndex("ai_agents_name_idx")
      .on(t.workspaceId, t.name)
      .where(sql`deleted_at IS NULL`),
    check("ai_agents_status_chk", sql`${t.status} IN ('disabled', 'enabled')`),
    check("ai_agents_trigger_type_chk", sql`${t.triggerType} IN ('manual', 'event')`),
    check(
      "ai_agents_event_trigger_chk",
      sql`${t.triggerType} <> 'event' OR ${t.triggerEvent} IS NOT NULL`,
    ),
    // The ceilings, restated where they cannot be argued with.
    check("ai_agents_max_steps_chk", sql`${t.maxSteps} BETWEEN 1 AND 12`),
    check("ai_agents_max_tool_calls_chk", sql`${t.maxToolCalls} BETWEEN 1 AND 24`),
    check("ai_agents_max_total_tokens_chk", sql`${t.maxTotalTokens} BETWEEN 1 AND 200000`),
  ],
)

export type AiAgent = typeof aiAgents.$inferSelect
export type NewAiAgent = typeof aiAgents.$inferInsert

/** One execution: the accounting, attribution and audit row. */
export const aiAgentRuns = pgTable(
  "ai_agent_runs",
  {
    ...baseColumns,
    ...workspaceColumn,
    agentId: uuid("agent_id")
      .notNull()
      .references(() => aiAgents.id, { onDelete: "cascade" }),
    triggerType: varchar("trigger_type", { length: 16 }).notNull(),
    triggerEvent: varchar("trigger_event", { length: 128 }),
    /** IDEMPOTENCY KEY: the event envelope id, or `manual:<uuid>`. */
    triggerEventId: varchar("trigger_event_id", { length: 128 }).notNull(),
    triggerPayload: jsonb("trigger_payload"),
    /** The task text of a manual run. NULL for event-triggered runs. */
    input: text("input"),
    entityType: varchar("entity_type", { length: 64 }),
    entityId: uuid("entity_id"),
    /** The OWNER this run inherits from. Plain uuid, no FK — see header. */
    actorId: uuid("actor_id"),
    /** The owner's role as resolved LIVE at execution time. */
    actorRole: varchar("actor_role", { length: 32 }),
    status: varchar("status", { length: 16 }).notNull().default("queued"),
    /** Loop protection, as on `workflow_runs`. */
    depth: integer("depth").notNull().default(0),
    parentRunId: uuid("parent_run_id").references((): AnyPgColumn => aiAgentRuns.id, {
      onDelete: "set null",
    }),
    /** Provider round-trips this run spent. */
    steps: integer("steps").notNull().default(0),
    toolCallCount: integer("tool_call_count").notNull().default(0),
    /** Changes PROPOSED to the approval queue. Never changes applied. */
    proposalCount: integer("proposal_count").notNull().default(0),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    /** Micro-USD (1e-6 USD). NULL when the model has no configured price. */
    costMicros: bigint("cost_micros", { mode: "number" }),
    providerId: varchar("provider_id", { length: 64 }),
    model: varchar("model", { length: 128 }),
    /** The agent's final answer, truncated. Never a tool payload. */
    summary: text("summary"),
    /** Per-call trace: name, access, outcome, duration, request id. */
    stepLog: jsonb("step_log"),
    errorCode: varchar("error_code", { length: 64 }),
    /** Redacted before it arrives. Never contains a credential. */
    error: text("error"),
    correlationId: varchar("correlation_id", { length: 128 }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("ai_agent_runs_workspace_idx").on(t.workspaceId),
    index("ai_agent_runs_agent_idx").on(t.agentId, t.createdAt),
    index("ai_agent_runs_status_idx").on(t.workspaceId, t.status, t.createdAt),
    // Usage and cost rollups: by workspace, by owner, over time.
    index("ai_agent_runs_usage_idx").on(t.workspaceId, t.actorId, t.createdAt),
    // IDEMPOTENCY: one run per (agent, triggering event), forever.
    uniqueIndex("ai_agent_runs_event_idx").on(t.agentId, t.triggerEventId),
    check(
      "ai_agent_runs_status_chk",
      sql`${t.status} IN ('queued', 'running', 'succeeded', 'failed', 'exhausted', 'denied', 'skipped')`,
    ),
    check("ai_agent_runs_trigger_type_chk", sql`${t.triggerType} IN ('manual', 'event')`),
    check("ai_agent_runs_depth_chk", sql`${t.depth} >= 0`),
  ],
)

export type AiAgentRun = typeof aiAgentRuns.$inferSelect
export type NewAiAgentRun = typeof aiAgentRuns.$inferInsert
