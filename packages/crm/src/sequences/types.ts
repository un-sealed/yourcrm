import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"

/**
 * Sales engagement / sequences ports (spec 47-sales-engagement, P0).
 *
 * `@yourcrm/crm` has no database dependency, so the service never imports
 * `@yourcrm/database`. It depends on the structural ports below; the API
 * layer adapts the drizzle repository (`sequences-repository.ts`),
 * `writeAudit`, the email and tasks services and the step queue to them,
 * and the hermetic test fakes satisfy them the same way. Same shape as the
 * `people` reference module and the `automation` engine.
 *
 * This is an ENGINE, and three of these ports exist specifically to keep
 * the three properties that matter honest — the same three the automation
 * engine solved, solved the same way, because there is exactly one
 * execution model in this product:
 *
 *  - `SalesSequenceStore.enrollPerson` / `.claimStepRun` return a
 *    `created` / `claimed` flag: IDEMPOTENCY is a database uniqueness
 *    result, not a decision the service makes.
 *  - `SalesSequenceActorRoleResolver` re-reads the sequence owner's LIVE
 *    workspace role at execution time: PERMISSION INHERITANCE cannot go
 *    stale, and a step can never be more privileged than its owner is
 *    today.
 *  - `SalesSequenceStepQueuePort` is the only way a step gets executed:
 *    nothing runs inline in the request path, and the delay between steps
 *    rides in the payload as an explicit `runAt`.
 */

/* --------------------------------- records -------------------------------- */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type SalesSequenceRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  status: string
}

export type SalesSequenceStepRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  sequenceId: string
  stepIndex: number
  stepType: string
}

export type SalesSequenceEnrollmentRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  sequenceId: string
  personId: string
  emailAddress: string
  status: string
  currentStepIndex: number
}

export type SalesSequenceStepRunRecord = Record<string, unknown> & {
  id: string
  enrollmentId: string
  stepIndex: number
  status: string
}

export type SalesSequenceListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
  status?: string
  ownerId?: string
}

export type SalesSequenceListResult = {
  data: SalesSequenceRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type SalesSequenceEnrollmentListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  sequenceId?: string
  personId?: string
  status?: string
  exitReason?: string
}

export type SalesSequenceEnrollmentListResult = {
  data: SalesSequenceEnrollmentRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

/** Per-enrollment and per-step counters. No opens/clicks in P0. */
export type SalesSequenceStats = {
  enrollments: { status: string; exitReason: string | null; count: number }[]
  steps: { stepIndex: number; stepType: string; status: string; count: number }[]
}

export type SalesSequenceWithSteps = {
  sequence: SalesSequenceRecord
  steps: SalesSequenceStepRecord[]
}

export type SalesSequenceEnrollmentWithRuns = {
  enrollment: SalesSequenceEnrollmentRecord
  runs: SalesSequenceStepRunRecord[]
}

/* ---------------------------------- store --------------------------------- */

/** One step as the editor saves it. Position in the array IS `stepIndex`. */
export type SalesSequenceStepDraft = {
  stepType: string
  name?: string | null
  waitDays?: number | null
  waitHours?: number | null
  config?: Record<string, unknown> | null
}

/** What an inbound signal is matched against to find enrollments to stop. */
export type SalesSequenceExitTarget = {
  threadId?: string | null
  personId?: string | null
  emailAddress?: string | null
}

export type SalesSequenceStore = {
  list(workspaceId: string, query: SalesSequenceListQuery): Promise<SalesSequenceListResult>
  findById(workspaceId: string, id: string): Promise<SalesSequenceRecord | null>
  create(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<SalesSequenceRecord>
  update(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<SalesSequenceRecord | null>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  restore(workspaceId: string, id: string): Promise<void>
  markEnrolled(workspaceId: string, id: string): Promise<void>

  listSteps(workspaceId: string, sequenceId: string): Promise<SalesSequenceStepRecord[]>
  replaceSteps(
    workspaceId: string,
    sequenceId: string,
    steps: SalesSequenceStepDraft[],
    actorId?: string,
  ): Promise<SalesSequenceStepRecord[]>

  /**
   * Insert an enrollment, or return the existing one for the same
   * (sequenceId, personId). `created: false` means this person is already
   * in the sequence — the caller must NOT start a second drip.
   */
  enrollPerson(
    workspaceId: string,
    input: Record<string, unknown>,
  ): Promise<{ enrollment: SalesSequenceEnrollmentRecord; created: boolean }>
  findEnrollmentById(workspaceId: string, id: string): Promise<SalesSequenceEnrollmentRecord | null>
  listEnrollments(
    workspaceId: string,
    query: SalesSequenceEnrollmentListQuery,
  ): Promise<SalesSequenceEnrollmentListResult>
  updateEnrollment(
    workspaceId: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<SalesSequenceEnrollmentRecord | null>
  incrementSentCount(workspaceId: string, id: string): Promise<SalesSequenceEnrollmentRecord | null>
  /** Live enrollments an inbound reply / bounce / unsubscribe should stop. */
  findActiveEnrollmentsByTarget(
    workspaceId: string,
    target: SalesSequenceExitTarget,
  ): Promise<SalesSequenceEnrollmentRecord[]>
  /**
   * Workspace-wide suppression: a previous unsubscribe or hard bounce for
   * this person, in ANY sequence. Non-null means do not enrol.
   */
  findSuppression(
    workspaceId: string,
    target: SalesSequenceExitTarget,
  ): Promise<SalesSequenceEnrollmentRecord | null>

  /**
   * Claim step `stepIndex` of `enrollmentId`. `claimed: false` means a
   * previous attempt already owned it — the caller must NOT send.
   */
  claimStepRun(
    workspaceId: string,
    input: {
      enrollmentId: string
      stepIndex: number
      stepType: string
      stepId?: string | null
      actorId?: string | null
      actorRole?: string | null
    },
  ): Promise<{ run: SalesSequenceStepRunRecord; claimed: boolean }>
  completeStepRun(
    workspaceId: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<SalesSequenceStepRunRecord | null>
  listStepRuns(workspaceId: string, enrollmentId: string): Promise<SalesSequenceStepRunRecord[]>

  stats(workspaceId: string, sequenceId: string): Promise<SalesSequenceStats>
}

/* ---------------------------------- ports --------------------------------- */

/**
 * Resolves an actor's LIVE workspace role. Returns `null` when the actor
 * is not (or no longer) a member — in which case the step is refused, not
 * downgraded to a default role.
 */
export type SalesSequenceActorRoleResolver = (
  workspaceId: string,
  actorId: string,
) => Promise<string | null>

/** One enqueue request. `runAt` is the delay between steps, made explicit. */
export type SalesSequenceStepJobRequest = {
  workspaceId: string
  sequenceId: string
  enrollmentId: string
  stepIndex: number
  /** When the step becomes due. Absent means "as soon as possible". */
  runAt?: Date
  correlationId?: string
}

/**
 * The queue seam.
 *
 * Domain code must never import BullMQ — or the transport package — so the
 * service depends on this shape and the API layer binds the real adapter.
 * `apps/worker/src/jobs/sequences.ts` is the worker half; it restates the
 * payload as a zod schema because a job must be a pure function of its own
 * validated input (spec 01). Same division of labour
 * `@yourcrm/workflows`' `WorkflowRunQueuePort` documents for automation.
 */
export type SalesSequenceStepQueuePort = {
  enqueueSequenceStep(request: SalesSequenceStepJobRequest): Promise<void>
}

/** The address a sequence sends to, resolved once at enrolment. */
export type SalesSequenceContactRecord = {
  personId: string
  emailAddress: string | null
}

/**
 * Resolves the person a caller wants to enrol. Bound in the API layer to
 * the PEOPLE module's own repository contract — this module never reads
 * another module's tables, and never invents an address.
 */
export type SalesSequenceContactResolverPort = (
  workspaceId: string,
  personId: string,
) => Promise<SalesSequenceContactRecord | null>

/**
 * Bindings to the modules that actually do the work. Every method receives
 * the SEQUENCE OWNER's service context — that is how permission
 * inheritance reaches the other module's own `requirePermission()` call,
 * on top of the check this service already made.
 *
 * EXTENSION POINT: new step types add a method here (see `schemas.ts`).
 */
export type SalesSequenceStepExecutorPort = {
  /**
   * Sends through the EMAIL module's service (spec 14), which re-checks
   * `send_external` and owns threading, sanitisation, audit and the
   * `email.sent` event. This module adds no second transport.
   */
  sendSequenceEmail(
    ctx: ServiceContext,
    input: {
      to: string
      subject: string
      bodyText: string
      bodyHtml?: string | null
      threadId?: string | null
      personId?: string | null
      dealId?: string | null
    },
  ): Promise<{ messageId: string; threadId: string | null }>
  createSequenceTask(
    ctx: ServiceContext,
    input: {
      title: string
      description?: string | null
      priority?: string | null
      dueDate?: string | null
      assigneeId?: string | null
      personId?: string | null
      dealId?: string | null
    },
  ): Promise<{ taskId: string }>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type SalesSequenceAuditInput = {
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

export type SalesSequenceServiceContext = ServiceContext

export type SalesSequenceServiceDeps = {
  store: SalesSequenceStore
  audit: AuditWriter<SalesSequenceAuditInput>
  /**
   * Reserved for the domain events this module owes (spec 47 §9). See the
   * BLOCKER note in `service.ts`: `@yourcrm/events` has no sequence event
   * group and this module may not add one, so nothing is emitted in P0 and
   * every mutation is audited instead. The port stays wired so adding the
   * constants is a one-file change.
   */
  events?: EventEmitter
  queue: SalesSequenceStepQueuePort
  executor: SalesSequenceStepExecutorPort
  resolveActorRole: SalesSequenceActorRoleResolver
  resolveContact: SalesSequenceContactResolverPort
  /** Injectable clock so step timing is deterministic in tests. */
  now?: () => Date
}

/* --------------------------------- results -------------------------------- */

export type SalesSequenceEnrollResult = {
  enrollment: SalesSequenceEnrollmentRecord
  /** `false` when this person was already enrolled — no second drip. */
  created: boolean
}

/** Why a step did not execute. Every value is a deliberate no-op. */
export type SalesSequenceStepSkipReason =
  | "enrollment_not_active"
  | "sequence_not_active"
  | "stale_step"
  | "already_attempted"
  | "no_such_step"

export type SalesSequenceStepOutcome = {
  enrollmentId: string
  stepIndex: number
  /** `executed` means the step really ran; anything else explains why not. */
  outcome: "executed" | "completed" | "failed" | SalesSequenceStepSkipReason
  status: string
  error?: string
}

/** One enrollment stopped by an inbound signal. */
export type SalesSequenceExitDecision = {
  enrollmentId: string
  sequenceId: string
  reason: string
}

export type SalesSequenceExitResult = {
  event: string
  reason: string | null
  stopped: SalesSequenceExitDecision[]
}
