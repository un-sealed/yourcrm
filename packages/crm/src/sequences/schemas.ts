import { z } from "zod"
import { CommunicationEvents } from "@yourcrm/events"
import { paginationQuerySchema } from "@yourcrm/validation"

/**
 * Sales sequence zod schemas (spec 47-sales-engagement, P0).
 *
 * Services validate inputs with these; API routes reuse them at the HTTP
 * boundary via `@hono/zod-validator`. Nothing here is a string literal
 * duplicating another module's vocabulary: the exit-trigger allowlist is
 * derived from the exported `@yourcrm/events` constants.
 *
 * Every exported name is prefixed `salesSequence` / `SalesSequence`:
 * `packages/crm/src/index.ts` is a single generated `export *` barrel
 * across two dozen modules, so a bare `Sequence` or `Enrollment` would
 * collide.
 */

/* -------------------------------- statuses -------------------------------- */

export const SALES_SEQUENCE_STATUSES = ["draft", "active", "paused", "archived"] as const

export type SalesSequenceStatusValue = (typeof SALES_SEQUENCE_STATUSES)[number]

export const salesSequenceStatusSchema = z.enum(SALES_SEQUENCE_STATUSES)

export const SALES_SEQUENCE_ENROLLMENT_STATUSES = [
  "active",
  "paused",
  "completed",
  "stopped",
  "failed",
] as const

export const salesSequenceEnrollmentStatusSchema = z.enum(SALES_SEQUENCE_ENROLLMENT_STATUSES)

export const SALES_SEQUENCE_EXIT_REASONS = [
  "replied",
  "bounced",
  "unsubscribed",
  "removed",
  "sequence_archived",
  "completed",
  "failed",
] as const

export type SalesSequenceExitReasonValue = (typeof SALES_SEQUENCE_EXIT_REASONS)[number]

export const salesSequenceExitReasonSchema = z.enum(SALES_SEQUENCE_EXIT_REASONS)

/** Exit reasons a human may choose. The rest are produced by the engine. */
export const salesSequenceManualExitReasonSchema = z.enum(["removed", "unsubscribed"])

/* ---------------------------------- steps --------------------------------- */

/**
 * P0 step vocabulary (spec 47 §3). Three types, each delegating to a
 * module that already exists:
 *   email -> `@yourcrm/crm/src/email`'s service
 *   task  -> `@yourcrm/crm/src/tasks`' service
 *   wait  -> pure scheduling, touches nothing
 *
 * EXTENSION POINT — deliberately NOT in P0: `sms`, `whatsapp` and `call`
 * steps (spec 47 §3 lists WhatsApp "where compliant"; consent handling is
 * a module of its own). Each lands as a variant below, a method on
 * `SalesSequenceStepExecutorPort`, a case in `service.ts`'s `performStep`
 * and an entry in `SALES_SEQUENCE_STEP_PERMISSIONS` — which already maps
 * anything outbound to the `send_external` permission action.
 */
export const SALES_SEQUENCE_STEP_TYPES = ["email", "task", "wait"] as const

export type SalesSequenceStepTypeValue = (typeof SALES_SEQUENCE_STEP_TYPES)[number]

export const salesSequenceStepTypeSchema = z.enum(SALES_SEQUENCE_STEP_TYPES)

/** Hard ceiling on steps per sequence (spec 47 §3: explicit limits). */
export const SALES_SEQUENCE_MAX_STEPS = 30

export const SALES_SEQUENCE_MAX_WAIT_DAYS = 365
export const SALES_SEQUENCE_MAX_WAIT_HOURS = 23

const waitDaysSchema = z.number().int().min(0).max(SALES_SEQUENCE_MAX_WAIT_DAYS).default(0)
const waitHoursSchema = z.number().int().min(0).max(SALES_SEQUENCE_MAX_WAIT_HOURS).default(0)

const stepNameSchema = z.string().trim().max(255).nullish()

/** Text fields support `{{field}}` placeholders from the enrolled person. */
const salesSequenceTemplateSchema = z.string().trim().min(1).max(255)

export const salesSequenceEmailStepSchema = z.object({
  stepType: z.literal("email"),
  name: stepNameSchema,
  /** Delay BEFORE the email goes out. */
  waitDays: waitDaysSchema,
  waitHours: waitHoursSchema,
  subject: salesSequenceTemplateSchema,
  bodyText: z.string().min(1).max(100_000),
  bodyHtml: z.string().max(200_000).nullish(),
})

export const salesSequenceTaskStepSchema = z.object({
  stepType: z.literal("task"),
  name: stepNameSchema,
  waitDays: waitDaysSchema,
  waitHours: waitHoursSchema,
  title: salesSequenceTemplateSchema,
  description: z.string().max(10_000).nullish(),
  priority: z.enum(["low", "medium", "high", "urgent"]).nullish(),
  /** Relative due date, resolved against the run clock. */
  dueInDays: z.number().int().min(0).max(365).nullish(),
  /** Defaults to the sequence owner — the actor the step executes as. */
  assigneeId: z.string().min(1).max(128).nullish(),
})

export const salesSequenceWaitStepSchema = z
  .object({
    stepType: z.literal("wait"),
    name: stepNameSchema,
    waitDays: waitDaysSchema,
    waitHours: waitHoursSchema,
  })
  .refine((step) => step.waitDays > 0 || step.waitHours > 0, {
    message: "a wait step needs a delay of at least one hour",
    path: ["waitDays"],
  })

export const salesSequenceStepSchema = z.union([
  salesSequenceEmailStepSchema,
  salesSequenceTaskStepSchema,
  salesSequenceWaitStepSchema,
])

export type SalesSequenceStepInput = z.infer<typeof salesSequenceStepSchema>

/**
 * The step editor saves the whole ordered list, not a diff: the stored
 * `step_index` is re-derived from array position, so what is persisted can
 * never disagree with the order the user saw.
 */
export const replaceSalesSequenceStepsSchema = z.object({
  steps: z.array(salesSequenceStepSchema).max(SALES_SEQUENCE_MAX_STEPS),
})

export type ReplaceSalesSequenceStepsInput = z.infer<typeof replaceSalesSequenceStepsSchema>

/** Split a validated step into the row columns and its opaque `config`. */
export function toSalesSequenceStepDraft(step: SalesSequenceStepInput): {
  stepType: string
  name: string | null
  waitDays: number
  waitHours: number
  config: Record<string, unknown>
} {
  const shared = {
    stepType: step.stepType,
    name: step.name ?? null,
    waitDays: step.waitDays,
    waitHours: step.waitHours,
  }
  switch (step.stepType) {
    case "email":
      return {
        ...shared,
        config: {
          subject: step.subject,
          bodyText: step.bodyText,
          bodyHtml: step.bodyHtml ?? null,
        },
      }
    case "task":
      return {
        ...shared,
        config: {
          title: step.title,
          description: step.description ?? null,
          priority: step.priority ?? null,
          dueInDays: step.dueInDays ?? null,
          assigneeId: step.assigneeId ?? null,
        },
      }
    case "wait":
      return { ...shared, config: {} }
  }
}

/**
 * Re-validation of a STORED step, just before it executes. A definition
 * saved by an older version — or edited around the API — never reaches the
 * executor unvalidated. Mirrors `parseActions` in the automation engine.
 */
export const storedSalesSequenceEmailConfigSchema = z.object({
  subject: z.string().min(1).max(255),
  bodyText: z.string().min(1).max(100_000),
  bodyHtml: z.string().max(200_000).nullish(),
})

export type StoredSalesSequenceEmailConfig = z.infer<typeof storedSalesSequenceEmailConfigSchema>

export const storedSalesSequenceTaskConfigSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(10_000).nullish(),
  priority: z.enum(["low", "medium", "high", "urgent"]).nullish(),
  dueInDays: z.number().int().min(0).max(365).nullish(),
  assigneeId: z.string().min(1).max(128).nullish(),
})

export type StoredSalesSequenceTaskConfig = z.infer<typeof storedSalesSequenceTaskConfigSchema>

/* ------------------------------- definition ------------------------------- */

export const createSalesSequenceSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2000).nullish(),
  ownerId: z.string().min(1).max(128).nullish(),
  exitOnReply: z.boolean().default(true),
  exitOnBounce: z.boolean().default(true),
  // Status is NOT settable at create: a new sequence is always a draft
  // until somebody who may send activates it.
})

export type CreateSalesSequenceInput = z.infer<typeof createSalesSequenceSchema>

export const updateSalesSequenceSchema = createSalesSequenceSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateSalesSequenceInput = z.infer<typeof updateSalesSequenceSchema>

export const salesSequenceQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
  status: salesSequenceStatusSchema.optional(),
  ownerId: z.string().min(1).max(128).optional(),
})

export type SalesSequenceQuery = z.infer<typeof salesSequenceQuerySchema>

/* ------------------------------- enrollment ------------------------------- */

export const enrollInSalesSequenceSchema = z.object({
  personId: z.string().min(1).max(128),
  dealId: z.string().min(1).max(128).nullish(),
  /**
   * Overrides the address resolved from the person record. Optional on
   * purpose: the normal path resolves it through the people module's own
   * contract so a sequence can never invent a recipient.
   */
  emailAddress: z.string().trim().email().max(320).nullish(),
})

export type EnrollInSalesSequenceInput = z.infer<typeof enrollInSalesSequenceSchema>

export const salesSequenceEnrollmentQuerySchema = paginationQuerySchema.extend({
  sequenceId: z.string().min(1).max(128).optional(),
  personId: z.string().min(1).max(128).optional(),
  status: salesSequenceEnrollmentStatusSchema.optional(),
  exitReason: salesSequenceExitReasonSchema.optional(),
})

export type SalesSequenceEnrollmentQuery = z.infer<typeof salesSequenceEnrollmentQuerySchema>

export const stopSalesSequenceEnrollmentSchema = z.object({
  reason: salesSequenceManualExitReasonSchema.default("removed"),
})

export type StopSalesSequenceEnrollmentInput = z.infer<typeof stopSalesSequenceEnrollmentSchema>

/**
 * Unsubscribe is workspace-wide, not per-sequence: somebody who opts out
 * must stop receiving outreach from every sequence, and must not be
 * enrollable into a new one.
 */
export const unsubscribeFromSalesSequencesSchema = z
  .object({
    personId: z.string().min(1).max(128).nullish(),
    emailAddress: z.string().trim().email().max(320).nullish(),
  })
  .refine((value) => Boolean(value.personId) || Boolean(value.emailAddress), {
    message: "an unsubscribe needs a personId or an emailAddress",
    path: ["personId"],
  })

export type UnsubscribeFromSalesSequencesInput = z.infer<typeof unsubscribeFromSalesSequencesSchema>

/* ----------------------------- exit triggers ------------------------------ */

/**
 * THE POINT OF THIS MODULE. Inbound events that stop an enrollment dead,
 * mapped to the exit reason they record.
 *
 * Built from the `@yourcrm/events` constants, never from string literals —
 * the email module (spec 14) already emits `email.received` when a reply
 * lands and `email.bounced` when a mailbox rejects us, and consuming those
 * is what keeps this module from inventing a second inbound path.
 *
 * A manual removal and an unsubscribe are service calls, not events, so
 * they are not in this table.
 */
export const SALES_SEQUENCE_EXIT_EVENTS: Readonly<Record<string, SalesSequenceExitReasonValue>> = {
  [CommunicationEvents.EmailReceived]: "replied",
  [CommunicationEvents.EmailBounced]: "bounced",
}

export function salesSequenceExitReasonForEvent(
  event: string,
): SalesSequenceExitReasonValue | null {
  return SALES_SEQUENCE_EXIT_EVENTS[event] ?? null
}

/**
 * An inbound email only ends a sequence when it came FROM the prospect.
 * Our own outbound copy lands on the same thread, so direction is the
 * difference between "they replied" and "we sent step 2".
 */
export function isSalesSequenceInboundDirection(value: unknown): boolean {
  return value === undefined || value === null || value === "inbound"
}

/* --------------------------------- outputs -------------------------------- */

export const salesSequenceSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  status: z.string(),
  ownerId: z.string().nullable().optional(),
  exitOnReply: z.boolean(),
  exitOnBounce: z.boolean(),
  lastEnrolledAt: z.unknown(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type SalesSequenceDto = z.infer<typeof salesSequenceSchema>

export const salesSequenceStepDtoSchema = z.object({
  id: z.string(),
  sequenceId: z.string(),
  stepIndex: z.number(),
  stepType: z.string(),
  name: z.string().nullable().optional(),
  waitDays: z.number(),
  waitHours: z.number(),
  config: z.unknown(),
})

export type SalesSequenceStepDto = z.infer<typeof salesSequenceStepDtoSchema>

export const salesSequenceEnrollmentSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  sequenceId: z.string(),
  personId: z.string(),
  dealId: z.string().nullable().optional(),
  emailAddress: z.string(),
  threadId: z.string().nullable().optional(),
  status: z.string(),
  exitReason: z.string().nullable().optional(),
  currentStepIndex: z.number(),
  nextRunAt: z.unknown(),
  sentCount: z.number(),
  error: z.string().nullable().optional(),
  startedAt: z.unknown(),
  lastStepAt: z.unknown(),
  completedAt: z.unknown(),
  stoppedAt: z.unknown(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type SalesSequenceEnrollmentDto = z.infer<typeof salesSequenceEnrollmentSchema>

export const salesSequenceStepRunSchema = z.object({
  id: z.string(),
  enrollmentId: z.string(),
  stepIndex: z.number(),
  stepType: z.string(),
  status: z.string(),
  result: z.unknown().nullable().optional(),
  error: z.string().nullable().optional(),
  actorRole: z.string().nullable().optional(),
  finishedAt: z.unknown(),
})

export type SalesSequenceStepRunDto = z.infer<typeof salesSequenceStepRunSchema>

/**
 * Catalogue that drives the web step editor: which step types exist, what
 * the limits are and which signals end an enrollment. Served by
 * `GET /sequences/catalogue` so the UI never hard-codes a vocabulary the
 * server would reject.
 */
export const salesSequenceCatalogueSchema = z.object({
  stepTypes: z.array(z.object({ type: z.string(), label: z.string() })),
  exitReasons: z.array(z.object({ reason: z.string(), label: z.string(), automatic: z.boolean() })),
  maxSteps: z.number(),
  maxWaitDays: z.number(),
  maxWaitHours: z.number(),
})

export type SalesSequenceCatalogue = z.infer<typeof salesSequenceCatalogueSchema>

const STEP_TYPE_LABELS: Record<SalesSequenceStepTypeValue, string> = {
  email: "Send an email",
  task: "Create a task",
  wait: "Wait",
}

const EXIT_REASON_LABELS: Record<SalesSequenceExitReasonValue, string> = {
  replied: "Replied",
  bounced: "Bounced",
  unsubscribed: "Unsubscribed",
  removed: "Removed by hand",
  sequence_archived: "Sequence archived",
  completed: "Finished every step",
  failed: "Failed",
}

/** Reasons the engine produces on its own, without anybody asking. */
const AUTOMATIC_EXIT_REASONS = new Set<string>([
  ...Object.values(SALES_SEQUENCE_EXIT_EVENTS),
  "completed",
  "failed",
  "sequence_archived",
])

export function describeSalesSequenceCatalogue(): SalesSequenceCatalogue {
  return {
    stepTypes: SALES_SEQUENCE_STEP_TYPES.map((type) => ({
      type,
      label: STEP_TYPE_LABELS[type],
    })),
    exitReasons: SALES_SEQUENCE_EXIT_REASONS.map((reason) => ({
      reason,
      label: EXIT_REASON_LABELS[reason],
      automatic: AUTOMATIC_EXIT_REASONS.has(reason),
    })),
    maxSteps: SALES_SEQUENCE_MAX_STEPS,
    maxWaitDays: SALES_SEQUENCE_MAX_WAIT_DAYS,
    maxWaitHours: SALES_SEQUENCE_MAX_WAIT_HOURS,
  }
}
