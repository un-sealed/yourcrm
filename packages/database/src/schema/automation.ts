import {
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
 * Workflow automation tables (spec 25-automation, P0).
 *
 * This is an ENGINE, not a CRUD module. Seventeen modules already emit
 * domain events; a workflow is a stored reaction to one of them:
 *
 *   trigger (a `@yourcrm/events` event name)
 *     -> conditions (filter tree evaluated against the event payload)
 *     -> ordered actions (create task / update field / add tag / notify)
 *
 * Three tables, all owned by this migration (0190_automation.sql):
 *
 *  - `workflows`          the definition, enabled or disabled per workspace
 *  - `workflow_runs`      one row per (workflow, triggering event)
 *  - `workflow_run_steps` one row per (run, action index)
 *
 * The two UNIQUE indexes are load-bearing, not hygiene:
 *
 *  - `workflow_runs_event_idx (workflow_id, trigger_event_id)` is the
 *    IDEMPOTENCY key. Event redelivery cannot create a second run, so the
 *    actions of a run cannot be applied twice.
 *  - `workflow_run_steps_index_idx (run_id, step_index)` is the per-step
 *    claim. A retried job re-claims each step and skips the ones already
 *    attempted, so a retry never re-applies a completed action.
 *
 * `workflow_runs.depth` carries the LOOP PROTECTION counter: an action
 * emits events, those events can trigger workflows, and each generation
 * increments `depth`. The domain service refuses to dispatch beyond
 * `WORKFLOW_MAX_CASCADE_DEPTH` (`@yourcrm/crm/src/automation`), recording a
 * `skipped` run instead, so a self-triggering workflow terminates.
 *
 * FK policy: `workflow_runs.workflow_id` and `workflow_run_steps.run_id`
 * reference tables created by THIS migration, and `parent_run_id` is a
 * self-reference. `owner_id` / `actor_id` / `created_by` stay plain uuid
 * columns with no foreign key — the same rule reports/dashboards follow.
 */

/* ------------------------------ filter model ------------------------------ */

/**
 * Persistence mirror of the `FilterTree` exported by `@yourcrm/ui`
 * (`packages/ui/src/filter-builder.tsx`). There is exactly ONE filter model
 * in the product: the builder's. `@yourcrm/database` is infrastructure and
 * must not import UI, so the shape is restated here exactly as
 * `schema/reports.ts` restates it — never widened, never re-invented.
 *
 *   group     = { type: "group", id, combinator: "and" | "or", children: [] }
 *   condition = { type: "condition", id, field, operator, value }
 */
export type WorkflowFilterCondition = {
  type: "condition"
  id: string
  field: string
  operator: string
  value?: unknown
}

export type WorkflowFilterGroup = {
  type: "group"
  id: string
  combinator: "and" | "or"
  children: WorkflowFilterNode[]
}

export type WorkflowFilterNode = WorkflowFilterCondition | WorkflowFilterGroup

/** Root of a stored condition tree is always a group (empty = match all). */
export type WorkflowFilterTree = WorkflowFilterGroup

/* --------------------------------- actions -------------------------------- */

/**
 * P0 action vocabulary. Deliberately small: every action here can be
 * performed by an existing module through its own service/repository
 * contract, so the engine never duplicates business rules.
 *
 * EXTENSION POINT — add a member here, a zod variant in
 * `@yourcrm/crm/src/automation/schemas.ts` and a method on
 * `WorkflowActionExecutorPort`. Deferred on purpose:
 *   `send_email`, `send_sms`, `send_whatsapp` — those modules do not exist
 *   yet (no email/SMS/WhatsApp transport is implemented);
 *   `call_webhook`, `assign_owner`, `create_activity`, `run_ai_agent`,
 *   `approval` and `delay` — P1 per spec 25 §3.
 */
export const WORKFLOW_ACTION_TYPES = ["create_task", "update_field", "add_tag", "notify"] as const

export type WorkflowActionType = (typeof WORKFLOW_ACTION_TYPES)[number]

export function isWorkflowActionType(value: unknown): value is WorkflowActionType {
  return typeof value === "string" && (WORKFLOW_ACTION_TYPES as readonly string[]).includes(value)
}

/**
 * One stored action. The discriminant is `type`; the remaining keys are
 * validated by the zod variant in the domain layer before they are stored,
 * so the repository keeps them opaque.
 */
export type WorkflowActionConfig = { type: WorkflowActionType } & Record<string, unknown>

/* -------------------------------- statuses -------------------------------- */

/** A workflow is off until somebody with automation admin turns it on. */
export const WORKFLOW_STATUSES = ["disabled", "enabled"] as const

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number]

export function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return typeof value === "string" && (WORKFLOW_STATUSES as readonly string[]).includes(value)
}

export const WORKFLOW_RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "skipped",
] as const

export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number]

/** Terminal run states: re-executing one of these is always a no-op. */
export const WORKFLOW_RUN_TERMINAL_STATUSES = ["succeeded", "failed", "skipped"] as const

export function isWorkflowRunStatus(value: unknown): value is WorkflowRunStatus {
  return typeof value === "string" && (WORKFLOW_RUN_STATUSES as readonly string[]).includes(value)
}

export function isTerminalWorkflowRunStatus(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (WORKFLOW_RUN_TERMINAL_STATUSES as readonly string[]).includes(value)
  )
}

export const WORKFLOW_RUN_STEP_STATUSES = ["running", "succeeded", "failed", "skipped"] as const

export type WorkflowRunStepStatus = (typeof WORKFLOW_RUN_STEP_STATUSES)[number]

export function isWorkflowRunStepStatus(value: unknown): value is WorkflowRunStepStatus {
  return (
    typeof value === "string" && (WORKFLOW_RUN_STEP_STATUSES as readonly string[]).includes(value)
  )
}

/** Hard ceiling on actions in one definition (spec 25 §3: explicit limits). */
export const WORKFLOW_MAX_ACTIONS = 20

/* --------------------------------- tables --------------------------------- */

export const workflows = pgTable(
  "workflows",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    /**
     * Domain event that fires this workflow, e.g. `person.created`. Always
     * one of the exported `@yourcrm/events` constants — the allowlist lives
     * in `@yourcrm/crm/src/automation/schemas.ts` (`WORKFLOW_TRIGGER_EVENTS`),
     * which is derived from the event package, never from string literals.
     *
     * EXTENSION POINT: cron/schedule triggers are out of scope for P0. They
     * land as a nullable `trigger_schedule` column plus a repeatable job on
     * the same queue seam; nothing here has to change.
     */
    triggerEvent: varchar("trigger_event", { length: 64 }).notNull(),
    /** Optional narrowing, e.g. only `deal` entities of a generic event. */
    triggerEntityType: varchar("trigger_entity_type", { length: 64 }),
    /** FilterTree evaluated against the flattened event payload. */
    conditions: jsonb("conditions").$type<WorkflowFilterTree | null>(),
    /** Ordered action list; executed head to tail, aborting on failure. */
    actions: jsonb("actions").$type<WorkflowActionConfig[]>().notNull().default([]),
    status: varchar("status", { length: 32 }).notNull().default("disabled"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  },
  (t) => [
    index("workflows_workspace_idx").on(t.workspaceId),
    // The dispatcher's hot path: "enabled workflows in this workspace
    // listening to this event".
    index("workflows_trigger_idx").on(t.workspaceId, t.triggerEvent, t.status),
    index("workflows_owner_idx").on(t.ownerId),
  ],
)

export type Workflow = typeof workflows.$inferSelect
export type NewWorkflow = typeof workflows.$inferInsert

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    ...baseColumns,
    ...workspaceColumn,
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    /** Envelope `eventId` of the triggering event — the idempotency key. */
    triggerEventId: varchar("trigger_event_id", { length: 128 }).notNull(),
    triggerEvent: varchar("trigger_event", { length: 64 }).notNull(),
    entityType: varchar("entity_type", { length: 64 }),
    entityId: varchar("entity_id", { length: 128 }),
    /** Frozen copy of the triggering envelope, for replay and debugging. */
    triggerPayload: jsonb("trigger_payload"),
    status: varchar("status", { length: 32 }).notNull().default("queued"),
    /** Cascade generation: 0 for a user-caused event, +1 per automation hop. */
    depth: integer("depth").notNull().default(0),
    /** The run this run cascaded from, if any (self-reference, own table). */
    parentRunId: uuid("parent_run_id").references((): AnyPgColumn => workflowRuns.id, {
      onDelete: "set null",
    }),
    /**
     * Workflow owner the actions run AS. Permission inheritance: every
     * action is checked with `requirePermission()` against this actor's
     * live workspace role, never the role of whoever caused the event.
     */
    actorId: uuid("actor_id"),
    actorRole: varchar("actor_role", { length: 32 }),
    correlationId: varchar("correlation_id", { length: 64 }),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("workflow_runs_workspace_idx").on(t.workspaceId),
    index("workflow_runs_workflow_idx").on(t.workflowId, t.createdAt),
    index("workflow_runs_status_idx").on(t.workspaceId, t.status),
    index("workflow_runs_parent_idx").on(t.parentRunId),
    // IDEMPOTENCY: one run per (workflow, triggering event) forever.
    uniqueIndex("workflow_runs_event_idx").on(t.workflowId, t.triggerEventId),
  ],
)

export type WorkflowRun = typeof workflowRuns.$inferSelect
export type NewWorkflowRun = typeof workflowRuns.$inferInsert

export const workflowRunSteps = pgTable(
  "workflow_run_steps",
  {
    ...baseColumns,
    ...workspaceColumn,
    runId: uuid("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    /** Position in the definition's `actions` array. */
    stepIndex: integer("step_index").notNull(),
    actionType: varchar("action_type", { length: 64 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("running"),
    /** What the action did, e.g. `{ taskId }` — never secrets. */
    result: jsonb("result"),
    error: text("error"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("workflow_run_steps_workspace_idx").on(t.workspaceId),
    // Per-step claim: a retried job cannot re-apply an attempted action.
    // Doubles as the ordered lookup index for "steps of this run".
    uniqueIndex("workflow_run_steps_index_idx").on(t.runId, t.stepIndex),
  ],
)

export type WorkflowRunStep = typeof workflowRunSteps.$inferSelect
export type NewWorkflowRunStep = typeof workflowRunSteps.$inferInsert
