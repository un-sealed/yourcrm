import { isNull } from "drizzle-orm"
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core"
import { baseColumns, uuid, workspaceColumn } from "./base"

/**
 * AI governance tables (spec 38-ai-governance, P0) — migration 0350.
 *
 * This is the gate every AI write passes through. An AI agent never
 * mutates a record: it proposes an `ai_action_request`, a human decides it
 * in `ai_action_approvals`, and only then does the governance service call
 * the owning module's domain service to apply it. `ai_policies` says which
 * (object, action) pairs need that approval, may skip it, or are refused
 * outright — and an unmatched pair REQUIRES APPROVAL.
 *
 * THE TWO DATABASE-LEVEL GUARANTEES
 * ---------------------------------
 *  - `ai_action_approvals_request_idx` UNIQUE (request_id): one decision
 *    per request, forever. "Approve twice" conflicts in Postgres; the
 *    repository reports `created: false` and nothing is applied again.
 *  - `ai_action_requests.apply_claimed_at` (and `revert_claimed_at`):
 *    claim-before-apply. The applier is only reached after
 *    `UPDATE ... WHERE status = 'approved' AND apply_claimed_at IS NULL`
 *    returns a row, so exactly one caller can ever apply a request.
 *
 * FK policy: `ai_action_approvals.request_id` and
 * `ai_action_requests.policy_id` point at tables created by THIS migration.
 * `actor_id` / `approver_id` / `created_by` stay plain uuid columns, and
 * the target of an action is the POLYMORPHIC pair
 * (`object_type`, `record_id`) with no foreign key at all — this module
 * governs objects whose modules may not exist yet.
 */

/* -------------------------------- vocabulary ------------------------------ */

/**
 * What an AI may propose to do. Each maps onto a `@yourcrm/permissions`
 * action, so the governance layer reuses the one permission model instead
 * of inventing an AI-specific one (see `crm/src/ai-governance/access.ts`).
 *
 * EXTENSION POINT: adding a member here means adding the matching entry to
 * `AI_ACTION_PERMISSIONS` — an action with no permission mapping must not
 * be storable.
 */
export const AI_ACTION_TYPES = ["create", "update", "delete", "send_external"] as const

export type AiActionType = (typeof AI_ACTION_TYPES)[number]

export function isAiActionType(value: unknown): value is AiActionType {
  return typeof value === "string" && (AI_ACTION_TYPES as readonly string[]).includes(value)
}

/** Lifecycle of one proposed mutation. */
export const AI_ACTION_REQUEST_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "applied",
  "reverted",
  "expired",
] as const

export type AiActionRequestStatus = (typeof AI_ACTION_REQUEST_STATUSES)[number]

export function isAiActionRequestStatus(value: unknown): value is AiActionRequestStatus {
  return (
    typeof value === "string" && (AI_ACTION_REQUEST_STATUSES as readonly string[]).includes(value)
  )
}

/** Statuses no decision or apply can move away from. */
export const AI_ACTION_TERMINAL_STATUSES = ["rejected", "reverted", "expired"] as const

export function isTerminalAiActionStatus(value: unknown): boolean {
  return (
    typeof value === "string" && (AI_ACTION_TERMINAL_STATUSES as readonly string[]).includes(value)
  )
}

/** Who proposed the action. Only a `user` may ever decide one. */
export const AI_ACTOR_TYPES = ["user", "agent"] as const

export type AiActorType = (typeof AI_ACTOR_TYPES)[number]

export function isAiActorType(value: unknown): value is AiActorType {
  return typeof value === "string" && (AI_ACTOR_TYPES as readonly string[]).includes(value)
}

export const AI_APPROVAL_DECISIONS = ["approved", "rejected"] as const

export type AiApprovalDecision = (typeof AI_APPROVAL_DECISIONS)[number]

export function isAiApprovalDecision(value: unknown): value is AiApprovalDecision {
  return typeof value === "string" && (AI_APPROVAL_DECISIONS as readonly string[]).includes(value)
}

/**
 * What a policy says about an (object, action) pair.
 *
 * `require_approval` is also what an UNMATCHED pair means, so the product
 * default is "a human decides". `auto_apply` still records the request,
 * still checks the requesting actor's live permissions and still claims
 * the row before applying — it only skips the human.
 */
export const AI_POLICY_MODES = ["require_approval", "auto_apply", "forbidden"] as const

export type AiPolicyMode = (typeof AI_POLICY_MODES)[number]

export function isAiPolicyMode(value: unknown): value is AiPolicyMode {
  return typeof value === "string" && (AI_POLICY_MODES as readonly string[]).includes(value)
}

/** Wildcard for "any object" / "any action" in a policy scope. */
export const AI_POLICY_WILDCARD = "*"

/* --------------------------------- tables --------------------------------- */

export const aiPolicies = pgTable(
  "ai_policies",
  {
    ...baseColumns,
    ...workspaceColumn,
    /** Target object, e.g. `person`, or `*` for every object. */
    objectType: varchar("object_type", { length: 64 }).notNull().default(AI_POLICY_WILDCARD),
    /** An `AiActionType`, or `*` for every action. */
    action: varchar("action", { length: 32 }).notNull().default(AI_POLICY_WILDCARD),
    mode: varchar("mode", { length: 32 }).notNull().default("require_approval"),
    description: text("description"),
    enabled: boolean("enabled").notNull().default(true),
  },
  (t) => [
    index("ai_policies_workspace_idx").on(t.workspaceId),
    // One live policy per scope; soft-deleted rows are excluded so a scope
    // can be re-created after deletion.
    uniqueIndex("ai_policies_scope_idx")
      .on(t.workspaceId, t.objectType, t.action)
      .where(isNull(t.deletedAt)),
  ],
)

export type AiPolicy = typeof aiPolicies.$inferSelect
export type NewAiPolicy = typeof aiPolicies.$inferInsert

export const aiActionRequests = pgTable(
  "ai_action_requests",
  {
    ...baseColumns,
    ...workspaceColumn,
    /** `user` (a person used an AI feature) or `agent` (an autonomous run). */
    actorType: varchar("actor_type", { length: 16 }).notNull().default("agent"),
    /**
     * The HUMAN whose permissions this action inherits. For an agent that
     * is its owner — an agent is never more privileged than the person
     * behind it, exactly as a workflow runs as its owner.
     */
    actorId: uuid("actor_id").notNull(),
    /** Opaque agent id. No FK: the agents module (spec 36) is not built. */
    agentId: varchar("agent_id", { length: 128 }),
    model: varchar("model", { length: 128 }),
    runId: varchar("run_id", { length: 128 }),
    correlationId: varchar("correlation_id", { length: 64 }),
    /** Polymorphic target — plain columns, deliberately no foreign key. */
    objectType: varchar("object_type", { length: 64 }).notNull(),
    /** NULL for a create: the record does not exist yet. */
    recordId: varchar("record_id", { length: 128 }),
    action: varchar("action", { length: 32 }).notNull(),
    /** `before` is what revert restores; `after` is what apply writes. */
    before: jsonb("before"),
    after: jsonb("after"),
    rationale: text("rationale"),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    policyId: uuid("policy_id").references(() => aiPolicies.id, { onDelete: "set null" }),
    policyMode: varchar("policy_mode", { length: 32 }).notNull().default("require_approval"),
    /** Audit only — the LIVE role is re-resolved before applying. */
    requestedRole: varchar("requested_role", { length: 32 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** EXACTLY-ONCE: set by the claim, never cleared. */
    applyClaimedAt: timestamp("apply_claimed_at", { withTimezone: true }),
    applyClaimedBy: uuid("apply_claimed_by"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    applyResult: jsonb("apply_result"),
    /** A failed apply keeps its claim: at-most-once beats a silent retry. */
    applyError: text("apply_error"),
    revertClaimedAt: timestamp("revert_claimed_at", { withTimezone: true }),
    revertClaimedBy: uuid("revert_claimed_by"),
    revertedAt: timestamp("reverted_at", { withTimezone: true }),
    revertError: text("revert_error"),
  },
  (t) => [
    index("ai_action_requests_workspace_idx").on(t.workspaceId),
    index("ai_action_requests_status_idx").on(t.workspaceId, t.status, t.createdAt),
    index("ai_action_requests_target_idx").on(t.workspaceId, t.objectType, t.recordId),
    index("ai_action_requests_run_idx").on(t.workspaceId, t.runId),
    index("ai_action_requests_actor_idx").on(t.workspaceId, t.actorId),
  ],
)

export type AiActionRequest = typeof aiActionRequests.$inferSelect
export type NewAiActionRequest = typeof aiActionRequests.$inferInsert

export const aiActionApprovals = pgTable(
  "ai_action_approvals",
  {
    ...baseColumns,
    ...workspaceColumn,
    requestId: uuid("request_id")
      .notNull()
      .references(() => aiActionRequests.id, { onDelete: "cascade" }),
    decision: varchar("decision", { length: 16 }).notNull(),
    /** Always a human, and never the requesting actor. */
    approverId: uuid("approver_id").notNull(),
    /**
     * Both live roles at decision time. The action executes with the
     * INTERSECTION of the two: every target permission is checked against
     * the approver AND the requester, so neither lends the other rights.
     */
    approverRole: varchar("approver_role", { length: 32 }),
    requesterRole: varchar("requester_role", { length: 32 }),
    reason: text("reason"),
    correlationId: varchar("correlation_id", { length: 64 }),
  },
  (t) => [
    index("ai_action_approvals_workspace_idx").on(t.workspaceId),
    // ONE DECISION PER REQUEST, FOREVER — what makes "approve twice"
    // impossible rather than merely unlikely.
    uniqueIndex("ai_action_approvals_request_idx").on(t.requestId),
  ],
)

export type AiActionApproval = typeof aiActionApprovals.$inferSelect
export type NewAiActionApproval = typeof aiActionApprovals.$inferInsert
