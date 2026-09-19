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
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { baseColumns, workspaceColumn } from "./base"

/**
 * AI assistant tables (spec 34-ai-assistant, P0). Migration `0340_ai.sql`.
 *
 * Three tables, one job each:
 *
 *  - `ai_conversations` — a chat thread. Personal: `user_id` is the person
 *    whose assistant session it is, and the domain service refuses to read
 *    somebody else's (see `packages/crm/src/ai-assistant/access.ts`).
 *  - `ai_messages` — the transcript, including the model's tool calls and
 *    the tool results, so the UI can show *why* an answer says what it
 *    says (spec 34 §3: tool-call transparency, source display).
 *  - `ai_runs` — the accounting and attribution row: which provider and
 *    model answered, how many tokens it burned, how long it took, what it
 *    cost and whether it succeeded. Everything spec 38-ai-governance needs
 *    for cost caps, usage alerts and an agent health dashboard reads from
 *    here; the audit trail (`audit_events`, `source = 'ai'`) carries the
 *    same run id.
 *
 * WHY A RUN IS NOT A MESSAGE
 * --------------------------
 * One question can cost several provider round-trips (ask → tool call →
 * tool result → answer) and therefore several assistant messages. The run
 * is the unit of *spend and attribution*; the message is the unit of
 * *conversation*. Collapsing them would either lose the intermediate tool
 * turns or double-count tokens. `ai_messages.run_id` links every row a run
 * produced back to it, which is what makes "attributable to a model + run
 * id" (a stated product principle) true for tool calls too.
 *
 * FOREIGN KEYS
 * ------------
 * `ai_messages.conversation_id` and `ai_runs.conversation_id` reference
 * `ai_conversations (id)` — same-module FKs, safe, with cascade delete.
 * `user_id` is a PLAIN uuid with an index and NO foreign key, like every
 * other actor column in this schema: `users` belongs to the auth
 * foundation (same rule as `people.company_id`, 0010_people.sql).
 * `ai_runs.message_id` is a plain uuid too — it points at the assistant
 * row a run finished with, and is written after that row exists; keeping
 * it unconstrained avoids an insert-order dependency for no real gain.
 *
 * NEVER STORED HERE
 * -----------------
 * No credential, ever. `ai_runs.error_message` is redacted at the provider
 * (`redactIntegrationSecrets`) before it reaches this table.
 */

export const AI_MESSAGE_ROLE_VALUES = ["system", "user", "assistant", "tool"] as const

export type AiMessageRole = (typeof AI_MESSAGE_ROLE_VALUES)[number]

export function isAiMessageRole(value: unknown): value is AiMessageRole {
  return typeof value === "string" && (AI_MESSAGE_ROLE_VALUES as readonly string[]).includes(value)
}

export const AI_RUN_OUTCOME_VALUES = ["succeeded", "failed", "denied"] as const

export type AiRunOutcome = (typeof AI_RUN_OUTCOME_VALUES)[number]

export function isAiRunOutcome(value: unknown): value is AiRunOutcome {
  return typeof value === "string" && (AI_RUN_OUTCOME_VALUES as readonly string[]).includes(value)
}

/** One chat thread, owned by one user. */
export const aiConversations = pgTable(
  "ai_conversations",
  {
    ...baseColumns,
    ...workspaceColumn,
    /** `users.id`. Plain uuid, no FK — see header. */
    userId: uuid("user_id"),
    title: varchar("title", { length: 255 }).notNull(),
    /** Last model that answered in this thread, for the list view. */
    model: varchar("model", { length: 128 }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  },
  (t) => [
    index("ai_conversations_workspace_idx").on(t.workspaceId),
    // The list query: this user's threads, newest activity first.
    index("ai_conversations_user_idx").on(t.workspaceId, t.userId, t.lastMessageAt),
  ],
)

export type AiConversation = typeof aiConversations.$inferSelect
export type NewAiConversation = typeof aiConversations.$inferInsert

/** One transcript row: question, answer, tool call or tool result. */
export const aiMessages = pgTable(
  "ai_messages",
  {
    ...baseColumns,
    ...workspaceColumn,
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => aiConversations.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 16 }).notNull(),
    content: text("content").notNull(),
    /** Assistant rows only: which model wrote this (spec 34 §14). */
    model: varchar("model", { length: 128 }),
    providerId: varchar("provider_id", { length: 64 }),
    /** `ai_runs.id`. Plain uuid: written before the run row is closed. */
    runId: uuid("run_id"),
    /** Requested calls (assistant rows) or the outcome summary (tool rows). */
    toolCalls: jsonb("tool_calls"),
    /** Provider tool-call id this row answers. Tool rows only. */
    toolCallId: varchar("tool_call_id", { length: 128 }),
    toolName: varchar("tool_name", { length: 128 }),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
  },
  (t) => [
    index("ai_messages_workspace_idx").on(t.workspaceId),
    // The transcript query: one thread in insertion order.
    index("ai_messages_conversation_idx").on(t.conversationId, t.createdAt),
    index("ai_messages_run_idx").on(t.runId),
    check("ai_messages_role_chk", sql`${t.role} IN ('system', 'user', 'assistant', 'tool')`),
  ],
)

export type AiMessage = typeof aiMessages.$inferSelect
export type NewAiMessage = typeof aiMessages.$inferInsert

/** One question answered: the accounting and attribution record. */
export const aiRuns = pgTable(
  "ai_runs",
  {
    ...baseColumns,
    ...workspaceColumn,
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => aiConversations.id, { onDelete: "cascade" }),
    /** Assistant message this run produced. Plain uuid — see header. */
    messageId: uuid("message_id"),
    /** `users.id` of the asker. Plain uuid, no FK. */
    actorId: uuid("actor_id"),
    providerId: varchar("provider_id", { length: 64 }).notNull(),
    model: varchar("model", { length: 128 }).notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    /** Micro-USD (1e-6 USD). NULL when the model has no configured price. */
    costMicros: bigint("cost_micros", { mode: "number" }),
    outcome: varchar("outcome", { length: 16 }).notNull(),
    errorCode: varchar("error_code", { length: 64 }),
    /** Redacted at the provider before it ever reaches this column. */
    errorMessage: text("error_message"),
    toolCallCount: integer("tool_call_count").notNull().default(0),
    /** Per-tool summary: name, outcome, duration. No payloads, no secrets. */
    toolCalls: jsonb("tool_calls"),
    correlationId: varchar("correlation_id", { length: 128 }),
  },
  (t) => [
    index("ai_runs_workspace_idx").on(t.workspaceId),
    index("ai_runs_conversation_idx").on(t.conversationId, t.createdAt),
    // Usage/cost rollups (spec 38): by workspace, by actor, over time.
    index("ai_runs_usage_idx").on(t.workspaceId, t.actorId, t.createdAt),
    check("ai_runs_outcome_chk", sql`${t.outcome} IN ('succeeded', 'failed', 'denied')`),
  ],
)

export type AiRun = typeof aiRuns.$inferSelect
export type NewAiRun = typeof aiRuns.$inferInsert
