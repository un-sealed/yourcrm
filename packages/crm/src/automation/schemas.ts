import { z } from "zod"
import {
  CalendarEvents,
  CommunicationEvents,
  CrmEvents,
  FileEvents,
  FormEvents,
  InvoiceEvents,
  PipelineEvents,
  ProductEvents,
  QuoteEvents,
} from "@yourcrm/events"
import { paginationQuerySchema } from "@yourcrm/validation"
import type { WorkflowFilterNode, WorkflowFilterTree } from "./types"

/**
 * Workflow automation zod schemas (spec 25-automation, P0).
 *
 * Services validate inputs with these; API routes reuse them at the HTTP
 * boundary via `@hono/zod-validator`. Nothing here is a string literal that
 * duplicates another module's vocabulary: the trigger allowlist is derived
 * from the exported `@yourcrm/events` constants, and the filter encoding is
 * the FilterBuilder's.
 */

/* -------------------------------- triggers -------------------------------- */

/**
 * Triggerable domain events, derived from the `@yourcrm/events` constants.
 *
 * Deliberately absent:
 *  - `AutomationEvents` (`workflow.run_started` / `.step_failed` /
 *    `.completed`) — a workflow must not be able to listen to the engine's
 *    own events. This is the cheapest layer of loop protection: the
 *    cascade can only grow through *business* events, which the depth
 *    counter then bounds.
 *  - `AiEvents`, `ReportEvents`, `DashboardEvents`, `SearchEvents`,
 *    `TransferEvents` — read/telemetry events with no useful reaction in
 *    P0. Adding one is a single line here.
 *
 * EXTENSION POINT: cron/schedule triggers are out of scope for P0 (spec 25
 * §3 lists them). They arrive as a second trigger *kind* — a nullable
 * schedule on the definition plus a repeatable job on the same queue seam
 * that produces the same `WorkflowTriggerEnvelope` the dispatcher already
 * takes, so neither the engine nor the storage shape changes.
 */
export const WORKFLOW_TRIGGER_EVENTS: readonly string[] = [
  ...Object.values(CrmEvents),
  ...Object.values(PipelineEvents),
  ...Object.values(ProductEvents),
  ...Object.values(FormEvents),
  ...Object.values(FileEvents),
  ...Object.values(QuoteEvents),
  ...Object.values(InvoiceEvents),
  ...Object.values(CalendarEvents),
  ...Object.values(CommunicationEvents),
]

const TRIGGER_EVENT_SET = new Set(WORKFLOW_TRIGGER_EVENTS)

export function isWorkflowTriggerEvent(value: unknown): value is string {
  return typeof value === "string" && TRIGGER_EVENT_SET.has(value)
}

export const workflowTriggerEventSchema = z
  .string()
  .refine(isWorkflowTriggerEvent, { message: "unknown trigger event" })

/* ------------------------------- conditions ------------------------------- */

/**
 * Operators of `@yourcrm/ui`'s FilterBuilder — the single filter model in
 * the product, identical to `reportFilterOperators`. The domain layer may
 * not import UI, so the list is restated, never extended.
 */
export const workflowFilterOperators = [
  "eq",
  "neq",
  "contains",
  "startsWith",
  "endsWith",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "notIn",
  "isEmpty",
  "isNotEmpty",
  "between",
] as const

export type WorkflowFilterOperator = (typeof workflowFilterOperators)[number]

export const workflowFilterOperatorSchema = z.enum(workflowFilterOperators)

const identifierSchema = z.string().trim().min(1).max(128)

const workflowFilterConditionSchema = z.object({
  type: z.literal("condition"),
  id: z.string().min(1).max(64),
  field: identifierSchema,
  operator: workflowFilterOperatorSchema,
  value: z.unknown().optional(),
})

const workflowFilterNodeSchema: z.ZodType<WorkflowFilterNode> = z.lazy(() =>
  z.union([workflowFilterConditionSchema, workflowFilterGroupSchema]),
)

const workflowFilterGroupSchema: z.ZodType<WorkflowFilterTree> = z.lazy(() =>
  z.object({
    type: z.literal("group"),
    id: z.string().min(1).max(64),
    combinator: z.enum(["and", "or"]),
    children: z.array(workflowFilterNodeSchema).max(50),
  }),
)

/** Root of a stored condition tree is always a group (empty = match all). */
export const workflowFilterTreeSchema = workflowFilterGroupSchema

/* --------------------------------- actions -------------------------------- */

/**
 * P0 actions. Each one is something an existing module already does, so
 * the engine calls that module's contract (via `WorkflowActionExecutorPort`)
 * instead of restating its rules.
 *
 * EXTENSION POINT — deliberately NOT in P0:
 *  - `send_email` / `send_sms` / `send_whatsapp`: no email, SMS or WhatsApp
 *    module exists yet, so there is nothing to delegate to. When one lands,
 *    add a variant below, a method on `WorkflowActionExecutorPort`, a case
 *    in `service.ts`'s `executeAction`, and an entry in
 *    `WORKFLOW_ACTION_PERMISSIONS` using the `send_external` permission
 *    action that `@yourcrm/permissions` already defines for exactly this.
 *  - `call_webhook`, `assign_owner`, `create_activity`, `run_ai_agent`,
 *    `approval`, `delay`: P1 (spec 25 §3).
 */
export const WORKFLOW_ACTION_TYPES = ["create_task", "update_field", "add_tag", "notify"] as const

export type WorkflowActionType = (typeof WORKFLOW_ACTION_TYPES)[number]

/** Text fields support `{{field}}` placeholders from the triggering record. */
const templateSchema = z.string().trim().min(1).max(255)

export const workflowCreateTaskActionSchema = z.object({
  type: z.literal("create_task"),
  title: templateSchema,
  description: z.string().max(10000).nullish(),
  priority: z.enum(["low", "medium", "high", "urgent"]).nullish(),
  /** Relative due date, resolved against the run clock. */
  dueInDays: z.number().int().min(0).max(365).nullish(),
  /** Defaults to the workflow owner — the actor the run executes as. */
  assigneeId: z.string().min(1).max(128).nullish(),
})

export const workflowUpdateFieldActionSchema = z.object({
  type: z.literal("update_field"),
  /** Field on the TRIGGERING record, not an arbitrary table. */
  field: identifierSchema,
  value: z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]),
})

export const workflowAddTagActionSchema = z.object({
  type: z.literal("add_tag"),
  tag: z.string().trim().min(1).max(128),
})

export const workflowNotifyActionSchema = z.object({
  type: z.literal("notify"),
  /** Defaults to the workflow owner. */
  userId: z.string().min(1).max(128).nullish(),
  title: templateSchema,
  body: z.string().max(2000).nullish(),
})

export const workflowActionSchema = z.discriminatedUnion("type", [
  workflowCreateTaskActionSchema,
  workflowUpdateFieldActionSchema,
  workflowAddTagActionSchema,
  workflowNotifyActionSchema,
])

export type WorkflowActionInput = z.infer<typeof workflowActionSchema>

/** Hard ceiling on actions per definition (spec 25 §3: explicit limits). */
export const WORKFLOW_MAX_ACTIONS = 20

/**
 * Which event an `update_field` action produces, per target object.
 *
 * The engine must emit the owning module's own event constant so the
 * record's timeline, search indexing and other workflows all see the
 * change exactly as they would from a hand edit. That is also what makes
 * cascades real — and therefore what loop protection has to bound.
 */
export const WORKFLOW_TARGET_UPDATED_EVENTS: Readonly<Record<string, string>> = {
  person: CrmEvents.PersonUpdated,
  company: CrmEvents.CompanyUpdated,
  lead: CrmEvents.LeadUpdated,
  deal: CrmEvents.DealUpdated,
  task: CrmEvents.TaskUpdated,
  activity: CrmEvents.ActivityUpdated,
}

/**
 * Maximum cascade generations. An action emits events, those events can
 * trigger workflows, and each generation increments `workflow_runs.depth`.
 * The dispatcher refuses to create a *runnable* run past this depth, so a
 * workflow that triggers itself terminates after this many hops.
 *
 * This is the canonical domain value: the queue payload carries it (see
 * `@yourcrm/workflows`' `workflowRunJobPayloadSchema`) rather than the
 * transport keeping a second copy that could drift.
 */
export const WORKFLOW_MAX_CASCADE_DEPTH = 5

/* -------------------------------- definition ------------------------------- */

export const WORKFLOW_STATUSES = ["disabled", "enabled"] as const

export const workflowStatusSchema = z.enum(WORKFLOW_STATUSES)

export const createWorkflowSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2000).nullish(),
  triggerEvent: workflowTriggerEventSchema,
  triggerEntityType: z.string().trim().max(64).nullish(),
  conditions: workflowFilterTreeSchema.nullish(),
  actions: z.array(workflowActionSchema).min(1).max(WORKFLOW_MAX_ACTIONS),
  ownerId: z.string().min(1).max(128).nullish(),
  // Status is NOT settable at create: a new workflow is always disabled
  // until somebody with `run_automation` enables it.
})

export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>

export const updateWorkflowSchema = createWorkflowSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateWorkflowInput = z.infer<typeof updateWorkflowSchema>

export const workflowQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
  status: workflowStatusSchema.optional(),
  triggerEvent: z.string().trim().max(64).optional(),
})

export type WorkflowQuery = z.infer<typeof workflowQuerySchema>

export const workflowRunQuerySchema = paginationQuerySchema.extend({
  workflowId: z.string().min(1).max(128).optional(),
  status: z.enum(["queued", "running", "succeeded", "failed", "skipped"]).optional(),
})

export type WorkflowRunQuery = z.infer<typeof workflowRunQuerySchema>

/**
 * Manual test run (spec 25 §3 "test mode with sample payload"). The caller
 * supplies the record the trigger would have carried; the engine builds a
 * synthetic envelope from the workflow's own trigger event, so a test run
 * exercises exactly the production path — including permissions.
 */
export const runWorkflowSchema = z.object({
  entityId: z.string().min(1).max(128).optional(),
  entityType: z.string().trim().max(64).optional(),
  sample: z.record(z.unknown()).optional(),
})

export type RunWorkflowInput = z.infer<typeof runWorkflowSchema>

/* --------------------------------- outputs -------------------------------- */

export const workflowSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  triggerEvent: z.string(),
  triggerEntityType: z.string().nullable().optional(),
  conditions: z.unknown().nullable().optional(),
  actions: z.unknown(),
  status: z.string(),
  ownerId: z.string().nullable().optional(),
  lastRunAt: z.unknown(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type WorkflowDto = z.infer<typeof workflowSchema>

export const workflowRunSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  workflowId: z.string(),
  triggerEventId: z.string(),
  triggerEvent: z.string(),
  entityType: z.string().nullable().optional(),
  entityId: z.string().nullable().optional(),
  status: z.string(),
  depth: z.number(),
  parentRunId: z.string().nullable().optional(),
  actorId: z.string().nullable().optional(),
  actorRole: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  startedAt: z.unknown(),
  finishedAt: z.unknown(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type WorkflowRunDto = z.infer<typeof workflowRunSchema>

export const workflowRunStepSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stepIndex: z.number(),
  actionType: z.string(),
  status: z.string(),
  result: z.unknown().nullable().optional(),
  error: z.string().nullable().optional(),
  finishedAt: z.unknown(),
})

export type WorkflowRunStepDto = z.infer<typeof workflowRunStepSchema>

/**
 * Catalogue that drives the web builder: which events can be listened to
 * and which actions can be taken. Served by `GET /automation/catalogue` so
 * the UI never hard-codes a vocabulary the server would reject.
 */
export const workflowCatalogueSchema = z.object({
  triggers: z.array(z.object({ event: z.string(), label: z.string(), domain: z.string() })),
  actions: z.array(z.object({ type: z.string(), label: z.string() })),
  maxActions: z.number(),
  maxCascadeDepth: z.number(),
})

export type WorkflowCatalogue = z.infer<typeof workflowCatalogueSchema>

const ACTION_LABELS: Record<WorkflowActionType, string> = {
  create_task: "Create a task",
  update_field: "Update a field on the record",
  add_tag: "Add a tag",
  notify: "Send an in-app notification",
}

function humanizeTriggerEvent(event: string): string {
  const [domain = event, verb = ""] = event.split(".")
  const subject = domain.replace(/_/g, " ")
  const predicate = verb.replace(/_/g, " ")
  const label = `${subject} ${predicate}`.trim()
  return label.charAt(0).toUpperCase() + label.slice(1)
}

/** Build the builder catalogue from the event constants (never literals). */
export function describeWorkflowCatalogue(): WorkflowCatalogue {
  return {
    triggers: WORKFLOW_TRIGGER_EVENTS.map((event) => ({
      event,
      label: humanizeTriggerEvent(event),
      domain: event.split(".")[0] ?? event,
    })),
    actions: WORKFLOW_ACTION_TYPES.map((type) => ({ type, label: ACTION_LABELS[type] })),
    maxActions: WORKFLOW_MAX_ACTIONS,
    maxCascadeDepth: WORKFLOW_MAX_CASCADE_DEPTH,
  }
}
