import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core"
import { baseColumns, ownerColumn, uuid, workspaceColumn } from "./base"

/**
 * Sales engagement / sequences tables (spec 47-sales-engagement, P0).
 *
 * This is an ENGINE, not a CRUD module. A sequence is an ordered list of
 * steps that executes against an enrolled person over days or weeks:
 *
 *   sequence -> steps (email | task | wait)
 *            -> enrollment (one person's cursor through those steps)
 *            -> step run   (one attempt at one step)
 *
 * Four tables, all owned by migration 0270_sales_engagement.sql.
 *
 * THE UNIQUE INDEXES ARE LOAD-BEARING
 * -----------------------------------
 *  - `sequence_step_runs_step_uidx (enrollment_id, step_index)` is the
 *    IDEMPOTENCY key. The runner claims the row BEFORE it sends; a retried
 *    job loses the insert and skips the action, so an email can never go
 *    out twice. Identical mechanism to `workflow_run_steps_index_idx`
 *    (0190_automation) — there is one execution model in this product.
 *  - `sequence_enrollments_person_uidx (sequence_id, person_id)` makes
 *    enrolment idempotent: enrolling somebody twice returns the existing
 *    enrollment rather than starting a parallel drip.
 *  - `sequence_steps_position_uidx (sequence_id, step_index)` keeps the
 *    step order a set, not a bag.
 *
 * EXIT CONDITIONS
 * ---------------
 * `sequence_enrollments.status` is the stop switch and the runner reads it
 * first: anything other than `active` means no step executes. So a job
 * already queued when the prospect replies simply does nothing — there is
 * no cancellation race to lose. `thread_id` is how an inbound reply finds
 * its enrollment (see `@yourcrm/crm/src/sequences`).
 *
 * FK POLICY: foreign keys only between the tables in this file.
 * `person_id`, `deal_id` and `thread_id` belong to the people, deals and
 * email modules and stay plain uuid columns with an index and no FK, as
 * `people.company_id` and `inbox_item_states.source_id` do. `owner_id` /
 * `enrolled_by` / `actor_id` point at users, same rule.
 */

/* -------------------------------- statuses -------------------------------- */

/** A sequence sends nothing until somebody activates it. */
export const SALES_SEQUENCE_STATUSES = ["draft", "active", "paused", "archived"] as const

export type SalesSequenceStatus = (typeof SALES_SEQUENCE_STATUSES)[number]

export function isSalesSequenceStatus(value: unknown): value is SalesSequenceStatus {
  return typeof value === "string" && (SALES_SEQUENCE_STATUSES as readonly string[]).includes(value)
}

/**
 * P0 step vocabulary. Deliberately three:
 *  - `email` delegates to the email module's own service (spec 14), so no
 *    second transport, no second consent path, no second audit trail;
 *  - `task` delegates to the tasks module;
 *  - `wait` is pure scheduling and touches nothing.
 *
 * EXTENSION POINT — `sms`, `whatsapp` and `call` steps are out of scope for
 * P0 (spec 47 §3). Each lands as a member here, a zod variant in
 * `@yourcrm/crm/src/sequences/schemas.ts`, a method on
 * `SalesSequenceStepExecutorPort` and an entry in
 * `SALES_SEQUENCE_STEP_PERMISSIONS` — all of which already use the
 * `send_external` permission action for anything that leaves the building.
 */
export const SALES_SEQUENCE_STEP_TYPES = ["email", "task", "wait"] as const

export type SalesSequenceStepType = (typeof SALES_SEQUENCE_STEP_TYPES)[number]

export function isSalesSequenceStepType(value: unknown): value is SalesSequenceStepType {
  return (
    typeof value === "string" && (SALES_SEQUENCE_STEP_TYPES as readonly string[]).includes(value)
  )
}

export const SALES_SEQUENCE_ENROLLMENT_STATUSES = [
  "active",
  "paused",
  "completed",
  "stopped",
  "failed",
] as const

export type SalesSequenceEnrollmentStatus = (typeof SALES_SEQUENCE_ENROLLMENT_STATUSES)[number]

export function isSalesSequenceEnrollmentStatus(
  value: unknown,
): value is SalesSequenceEnrollmentStatus {
  return (
    typeof value === "string" &&
    (SALES_SEQUENCE_ENROLLMENT_STATUSES as readonly string[]).includes(value)
  )
}

/**
 * Only `active` enrollments execute. Every other state is a hard stop the
 * runner checks before it does anything — that is the whole of "a sequence
 * never continues after a stop condition" (spec 47 §20).
 */
export function isSalesSequenceEnrollmentRunnable(value: unknown): boolean {
  return value === "active"
}

/**
 * Why an enrollment stopped. `replied`, `bounced` and `unsubscribed` are
 * the automatic exits; `removed` is a human pulling somebody out;
 * `sequence_archived` is the whole sequence being retired underneath them.
 */
export const SALES_SEQUENCE_EXIT_REASONS = [
  "replied",
  "bounced",
  "unsubscribed",
  "removed",
  "sequence_archived",
  "completed",
  "failed",
] as const

export type SalesSequenceExitReason = (typeof SALES_SEQUENCE_EXIT_REASONS)[number]

export function isSalesSequenceExitReason(value: unknown): value is SalesSequenceExitReason {
  return (
    typeof value === "string" && (SALES_SEQUENCE_EXIT_REASONS as readonly string[]).includes(value)
  )
}

/**
 * Exit reasons that suppress the person workspace-wide, not just in the
 * sequence they escaped. Emailing somebody who unsubscribed — or whose
 * mailbox hard-bounced — from a *different* sequence is the same mistake
 * twice, so enrolment checks these across every sequence in the workspace.
 */
export const SALES_SEQUENCE_SUPPRESSING_EXIT_REASONS = ["unsubscribed", "bounced"] as const

export const SALES_SEQUENCE_STEP_RUN_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "skipped",
] as const

export type SalesSequenceStepRunStatus = (typeof SALES_SEQUENCE_STEP_RUN_STATUSES)[number]

export function isSalesSequenceStepRunStatus(value: unknown): value is SalesSequenceStepRunStatus {
  return (
    typeof value === "string" &&
    (SALES_SEQUENCE_STEP_RUN_STATUSES as readonly string[]).includes(value)
  )
}

/** Hard ceiling on steps per sequence (spec 47 §3: explicit limits). */
export const SALES_SEQUENCE_MAX_STEPS = 30

/** Longest delay a single step may impose, mirroring the SQL CHECKs. */
export const SALES_SEQUENCE_MAX_WAIT_DAYS = 365
export const SALES_SEQUENCE_MAX_WAIT_HOURS = 23

/**
 * Step payload. The discriminant is `stepType` on the row; the JSON is
 * validated by the matching zod variant in the domain layer before it is
 * stored, so the repository keeps it opaque.
 */
export type SalesSequenceStepConfig = Record<string, unknown>

/* --------------------------------- tables --------------------------------- */

export const salesSequences = pgTable(
  "sequences",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    status: varchar("status", { length: 32 }).notNull().default("draft"),
    /** Stop when the prospect replies. On by default; spec 47 §3. */
    exitOnReply: boolean("exit_on_reply").notNull().default(true),
    /** Stop when their mailbox bounces. On by default. */
    exitOnBounce: boolean("exit_on_bounce").notNull().default(true),
    lastEnrolledAt: timestamp("last_enrolled_at", { withTimezone: true }),
  },
  (t) => [
    index("sequences_workspace_idx").on(t.workspaceId),
    index("sequences_status_idx").on(t.workspaceId, t.status),
    index("sequences_owner_idx").on(t.ownerId),
  ],
)

export type SalesSequence = typeof salesSequences.$inferSelect
export type NewSalesSequence = typeof salesSequences.$inferInsert

export const salesSequenceSteps = pgTable(
  "sequence_steps",
  {
    ...baseColumns,
    ...workspaceColumn,
    sequenceId: uuid("sequence_id")
      .notNull()
      .references(() => salesSequences.id, { onDelete: "cascade" }),
    /** 0-based position, and the idempotency coordinate on the run table. */
    stepIndex: integer("step_index").notNull(),
    stepType: varchar("step_type", { length: 16 }).notNull(),
    name: varchar("name", { length: 255 }),
    /** Delay applied BEFORE this step runs. */
    waitDays: integer("wait_days").notNull().default(0),
    waitHours: integer("wait_hours").notNull().default(0),
    config: jsonb("config").$type<SalesSequenceStepConfig>().notNull().default({}),
  },
  (t) => [
    index("sequence_steps_workspace_idx").on(t.workspaceId),
    uniqueIndex("sequence_steps_position_uidx").on(t.sequenceId, t.stepIndex),
  ],
)

export type SalesSequenceStep = typeof salesSequenceSteps.$inferSelect
export type NewSalesSequenceStep = typeof salesSequenceSteps.$inferInsert

export const salesSequenceEnrollments = pgTable(
  "sequence_enrollments",
  {
    ...baseColumns,
    ...workspaceColumn,
    sequenceId: uuid("sequence_id")
      .notNull()
      .references(() => salesSequences.id, { onDelete: "cascade" }),
    /** people.id — plain uuid, no FK (the people module owns that table). */
    personId: uuid("person_id").notNull(),
    dealId: uuid("deal_id"),
    /** Resolved once, at enrolment: a later contact edit cannot redirect it. */
    emailAddress: varchar("email_address", { length: 320 }).notNull(),
    /** email_threads.id — how an inbound reply finds this enrollment. */
    threadId: uuid("thread_id"),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    exitReason: varchar("exit_reason", { length: 32 }),
    currentStepIndex: integer("current_step_index").notNull().default(0),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    sentCount: integer("sent_count").notNull().default(0),
    enrolledBy: uuid("enrolled_by"),
    /** Owner role at the last executed step, for the audit trail. */
    actorRole: varchar("actor_role", { length: 32 }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    lastStepAt: timestamp("last_step_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => [
    index("sequence_enrollments_workspace_idx").on(t.workspaceId),
    index("sequence_enrollments_sequence_idx").on(t.sequenceId, t.createdAt),
    index("sequence_enrollments_person_idx").on(t.workspaceId, t.personId),
    index("sequence_enrollments_thread_idx").on(t.workspaceId, t.threadId),
    index("sequence_enrollments_email_idx").on(t.workspaceId, t.emailAddress),
    index("sequence_enrollments_due_idx").on(t.workspaceId, t.status, t.nextRunAt),
    // One enrollment per (sequence, person) forever: enrolment is idempotent.
    uniqueIndex("sequence_enrollments_person_uidx").on(t.sequenceId, t.personId),
  ],
)

export type SalesSequenceEnrollment = typeof salesSequenceEnrollments.$inferSelect
export type NewSalesSequenceEnrollment = typeof salesSequenceEnrollments.$inferInsert

export const salesSequenceStepRuns = pgTable(
  "sequence_step_runs",
  {
    ...baseColumns,
    ...workspaceColumn,
    enrollmentId: uuid("enrollment_id")
      .notNull()
      .references(() => salesSequenceEnrollments.id, { onDelete: "cascade" }),
    /** SET NULL: a step may be deleted after it has already run for somebody. */
    stepId: uuid("step_id").references(() => salesSequenceSteps.id, { onDelete: "set null" }),
    stepIndex: integer("step_index").notNull(),
    stepType: varchar("step_type", { length: 16 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("running"),
    /** `{ messageId, threadId }` or `{ taskId }`. Never bodies, never secrets. */
    result: jsonb("result"),
    error: text("error"),
    actorId: uuid("actor_id"),
    actorRole: varchar("actor_role", { length: 32 }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("sequence_step_runs_workspace_idx").on(t.workspaceId),
    index("sequence_step_runs_step_idx").on(t.stepId),
    // THE send-once guarantee: claim before send, one claim per slot.
    uniqueIndex("sequence_step_runs_step_uidx").on(t.enrollmentId, t.stepIndex),
  ],
)

export type SalesSequenceStepRun = typeof salesSequenceStepRuns.$inferSelect
export type NewSalesSequenceStepRun = typeof salesSequenceStepRuns.$inferInsert

/* --------------------------------- helpers -------------------------------- */

/** Total delay a step imposes, in milliseconds. */
export function salesSequenceStepDelayMs(step: {
  waitDays?: number | null
  waitHours?: number | null
}): number {
  const days = Math.max(0, step.waitDays ?? 0)
  const hours = Math.max(0, step.waitHours ?? 0)
  return (days * 24 + hours) * 60 * 60 * 1000
}
