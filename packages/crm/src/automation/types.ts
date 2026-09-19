import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"

/**
 * Workflow automation ports (mirrors the `people` reference module).
 *
 * `@yourcrm/crm` has no database dependency, so the service never imports
 * `@yourcrm/database`. It depends on these structural ports instead; the
 * API layer adapts the drizzle repository (`automation-repository.ts`),
 * `writeAudit`, the other modules' services and the run queue to them, and
 * the hermetic test fakes satisfy them the same way.
 *
 * This module is an ENGINE. Three of these ports exist specifically to
 * keep the three properties that matter honest:
 *
 *  - `WorkflowAutomationStore.createRun` / `.claimRunStep` return a
 *    `created` / `claimed` flag: IDEMPOTENCY is a database uniqueness
 *    result, not a decision the service makes.
 *  - `WorkflowActorRoleResolver` re-reads the workflow owner's LIVE
 *    workspace role at run time: PERMISSION INHERITANCE cannot go stale,
 *    and the run can never be more privileged than its owner is today.
 *  - `WorkflowRunQueuePort` is the only way a run gets executed: nothing
 *    runs inline in the request path, and LOOP PROTECTION rides in the
 *    payload as an explicit depth.
 */

/* ------------------------------ filter model ------------------------------ */

/**
 * Filter tree in the encoding exported by `@yourcrm/ui`'s FilterBuilder
 * (`FilterTree`). There is exactly ONE filter model in the product; the
 * domain layer may not import UI, so the shape is restated here and in
 * `@yourcrm/database`'s `schema/automation.ts` — exactly as
 * `crm/src/reports/types.ts` does it. Keep the three in step; never
 * introduce another model.
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

export type WorkflowFilterTree = WorkflowFilterGroup

/* --------------------------------- records -------------------------------- */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type WorkflowRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
}

export type WorkflowRunRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  workflowId: string
  status: string
  depth: number
}

export type WorkflowRunStepRecord = Record<string, unknown> & {
  id: string
  runId: string
  stepIndex: number
  status: string
}

export type WorkflowListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
  status?: string
  triggerEvent?: string
}

export type WorkflowListResult = {
  data: WorkflowRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type WorkflowRunListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  workflowId?: string
  status?: string
}

export type WorkflowRunListResult = {
  data: WorkflowRunRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

/* --------------------------------- trigger -------------------------------- */

/**
 * The triggering event, in the `@yourcrm/events` envelope shape restated
 * structurally (the service does import the events package for its
 * constants, but the dispatcher accepts anything envelope-shaped so a
 * future transport — a Redis fan-out, a webhook receiver, a cron tick —
 * can feed it without a new contract).
 */
export type WorkflowTriggerEnvelope = {
  eventId: string
  event: string
  workspaceId: string
  actorId?: string
  actorType?: string
  entityType?: string
  entityId?: string
  before?: unknown
  after?: unknown
  correlationId?: string
}

/* ---------------------------------- store --------------------------------- */

export type WorkflowAutomationStore = {
  list(workspaceId: string, query: WorkflowListQuery): Promise<WorkflowListResult>
  findById(workspaceId: string, id: string): Promise<WorkflowRecord | null>
  create(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<WorkflowRecord>
  update(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<WorkflowRecord | null>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  restore(workspaceId: string, id: string): Promise<void>
  /** Live, enabled definitions listening to this event. */
  listEnabledByTrigger(workspaceId: string, triggerEvent: string): Promise<WorkflowRecord[]>
  markWorkflowRan(workspaceId: string, id: string): Promise<void>
  /**
   * Insert a run, or return the existing one for the same
   * (workflowId, triggerEventId). `created: false` means the event was
   * already processed — the caller must NOT enqueue it again.
   */
  createRun(
    workspaceId: string,
    input: Record<string, unknown>,
  ): Promise<{ run: WorkflowRunRecord; created: boolean }>
  findRunById(workspaceId: string, id: string): Promise<WorkflowRunRecord | null>
  listRuns(workspaceId: string, query: WorkflowRunListQuery): Promise<WorkflowRunListResult>
  updateRun(
    workspaceId: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<WorkflowRunRecord | null>
  /**
   * Claim step `stepIndex` of `runId`. `claimed: false` means a previous
   * attempt already owned it — the caller must NOT execute the action.
   */
  claimRunStep(
    workspaceId: string,
    input: { runId: string; stepIndex: number; actionType: string },
  ): Promise<{ step: WorkflowRunStepRecord; claimed: boolean }>
  completeRunStep(
    workspaceId: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<WorkflowRunStepRecord | null>
  listRunSteps(workspaceId: string, runId: string): Promise<WorkflowRunStepRecord[]>
}

/* ---------------------------------- ports --------------------------------- */

/**
 * Resolves an actor's LIVE workspace role. Returns `null` when the actor
 * is not (or no longer) a member — in which case the run is refused, not
 * downgraded to a default role.
 */
export type WorkflowActorRoleResolver = (
  workspaceId: string,
  actorId: string,
) => Promise<string | null>

/** One enqueue request. `maxDepth` travels with it — see loop protection. */
export type WorkflowRunJobRequest = {
  workspaceId: string
  workflowId: string
  runId: string
  triggerEventId: string
  depth: number
  maxDepth: number
  correlationId?: string
}

/**
 * The queue seam.
 *
 * Structural restatement of `WorkflowRunQueuePort` from
 * `@yourcrm/workflows` (the canonical definition, which also owns the job
 * name, the payload schema and the deterministic job id). Domain code must
 * never import BullMQ — or, for that matter, the transport package — so
 * the service depends on this shape and the API layer binds the real
 * adapter. Same reason `AuditWriter` and the FilterTree are restated.
 */
export type WorkflowRunQueuePort = {
  enqueueWorkflowRun(request: WorkflowRunJobRequest): Promise<void>
}

/** Target record of an action: the record whose event fired the workflow. */
export type WorkflowActionTarget = {
  entityType: string
  entityId: string
}

/**
 * Bindings to the modules that actually do the work. Every method receives
 * the OWNER's service context — that is how permission inheritance reaches
 * the other module's own `requirePermission()` call, on top of the check
 * this service already made.
 *
 * EXTENSION POINT: new action types add a method here (see
 * `schemas.ts` for the deferred list).
 */
export type WorkflowActionExecutorPort = {
  createTask(
    ctx: ServiceContext,
    input: {
      title: string
      description?: string | null
      priority?: string | null
      dueDate?: string | null
      assigneeId?: string | null
      target?: WorkflowActionTarget | null
    },
  ): Promise<{ taskId: string }>
  updateRecordField(
    ctx: ServiceContext,
    target: WorkflowActionTarget,
    field: string,
    value: string | number | boolean | null,
  ): Promise<{ recordId: string }>
  addTag(ctx: ServiceContext, target: WorkflowActionTarget, tag: string): Promise<{ tagId: string }>
  notify(
    ctx: ServiceContext,
    input: { userId: string; type: string; title: string; body?: string | null },
  ): Promise<{ notificationId: string }>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type WorkflowAuditInput = {
  workspaceId: string
  actorId?: string | null
  action: string
  object: string
  recordId?: string | null
  before?: unknown
  after?: unknown
  correlationId?: string | null
  source?: "user" | "automation" | "ai" | "integration" | "mcp"
}

export type WorkflowAutomationServiceContext = ServiceContext

export type WorkflowAutomationServiceDeps = {
  store: WorkflowAutomationStore
  audit: AuditWriter<WorkflowAuditInput>
  events?: EventEmitter
  queue: WorkflowRunQueuePort
  executor: WorkflowActionExecutorPort
  resolveActorRole: WorkflowActorRoleResolver
  /** Injectable clock so run timing is deterministic in tests. */
  now?: () => Date
}

/* --------------------------------- results -------------------------------- */

/** Why a matched workflow did not produce a runnable run. */
export type WorkflowDispatchSkipReason = "duplicate" | "cascade_depth" | "queue_failed"

export type WorkflowDispatchDecision = {
  workflowId: string
  runId: string
  /** `queued` means it was enqueued; anything else explains why not. */
  outcome: "queued" | WorkflowDispatchSkipReason
}

export type WorkflowDispatchResult = {
  event: string
  eventId: string
  depth: number
  matched: number
  decisions: WorkflowDispatchDecision[]
}

export type WorkflowRunOutcome = {
  runId: string
  status: string
  /** Steps actually executed by THIS attempt (retries re-run nothing). */
  executedSteps: number
  error?: string
}

export type WorkflowWithRuns = {
  workflow: WorkflowRecord
  runs: WorkflowRunRecord[]
}

export type WorkflowRunWithSteps = {
  run: WorkflowRunRecord
  steps: WorkflowRunStepRecord[]
}
