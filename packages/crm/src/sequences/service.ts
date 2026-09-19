import { requirePermission, PermissionDeniedError } from "@yourcrm/permissions"
import {
  assertSalesSequenceActorResolved,
  assertSalesSequenceStepAllowed,
  salesSequencePermission,
  SALES_SEQUENCE_ENROLLMENT_OBJECT,
  SALES_SEQUENCE_OBJECT,
} from "./access"
import {
  createSalesSequenceSchema,
  enrollInSalesSequenceSchema,
  isSalesSequenceInboundDirection,
  replaceSalesSequenceStepsSchema,
  salesSequenceEnrollmentQuerySchema,
  salesSequenceExitReasonForEvent,
  salesSequenceQuerySchema,
  salesSequenceStatusSchema,
  stopSalesSequenceEnrollmentSchema,
  storedSalesSequenceEmailConfigSchema,
  storedSalesSequenceTaskConfigSchema,
  toSalesSequenceStepDraft,
  unsubscribeFromSalesSequencesSchema,
  updateSalesSequenceSchema,
  type SalesSequenceExitReasonValue,
  type SalesSequenceStatusValue,
  type SalesSequenceStepTypeValue,
} from "./schemas"
import type {
  SalesSequenceEnrollmentListResult,
  SalesSequenceEnrollmentRecord,
  SalesSequenceEnrollmentWithRuns,
  SalesSequenceEnrollResult,
  SalesSequenceExitDecision,
  SalesSequenceExitResult,
  SalesSequenceListResult,
  SalesSequenceRecord,
  SalesSequenceServiceContext,
  SalesSequenceServiceDeps,
  SalesSequenceStats,
  SalesSequenceStepOutcome,
  SalesSequenceStepRecord,
  SalesSequenceWithSteps,
} from "./types"

/**
 * Sales engagement / sequences service (spec 47-sales-engagement, P0).
 *
 * An ENGINE, not a CRUD module: a sequence is an ordered list of steps
 * that executes against an enrolled person over days or weeks, one queued
 * job per step. It reimplements nothing — an email step goes through the
 * EMAIL module's service (spec 14), a task step through the TASKS module's
 * — so there is no second transport, no second consent path and no second
 * audit trail.
 *
 * THE THREE PROPERTIES
 * --------------------
 * 1. EXIT CONDITIONS — the reason the module exists. A sequence that keeps
 *    emailing somebody who replied is worse than no sequence, so the stop
 *    switch is a STATE, not a cancellation: `executeStep` refuses to do
 *    anything for an enrollment whose status is not `active`, and stopping
 *    one is a single write. A job already sitting on the queue when the
 *    reply lands therefore becomes a no-op — there is no race to lose and
 *    nothing to un-schedule. `handleInboundEvent` turns
 *    `CommunicationEvents.EmailReceived` / `.EmailBounced` into that
 *    write; `stopEnrollment` and `unsubscribe` are the human versions.
 *    Unsubscribes and hard bounces also suppress the person WORKSPACE-WIDE
 *    at enrolment, so escaping one sequence is not an invitation into the
 *    next.
 *
 * 2. IDEMPOTENCY. A step is keyed on (enrollment, step index): the runner
 *    CLAIMS the `sequence_step_runs` row against the UNIQUE index BEFORE
 *    it sends, and a retried job that loses the insert skips the action
 *    entirely. Enrolment is keyed the same way on (sequence, person). Both
 *    guarantees live in Postgres, not in a cache, so two workers racing on
 *    a redelivered job still send exactly one email.
 *
 * 3. PERMISSION INHERITANCE. A step executes as the sequence's OWNER. The
 *    owner's role is re-read live (`resolveActorRole`) at execution time,
 *    the step is refused outright if they are no longer a member, and
 *    every step calls `requirePermission()` against that role before it
 *    runs (`access.ts`) — `send_external` for an email. A denial fails the
 *    step, stops the enrollment and is recorded; it never falls through to
 *    the executor. Sending also passes through the email service's own
 *    `send_external` check, so the gate is enforced twice by two owners.
 *
 * Nothing here touches BullMQ, Redis or Postgres: steps leave through
 * `SalesSequenceStepQueuePort` and state lands through `SalesSequenceStore`.
 *
 * BLOCKER — DOMAIN EVENTS
 * -----------------------
 * Spec 47 §9 asks for `sequence.enrolled`, `sequence.step_executed`,
 * `sequence.stopped` and `sequence.replied`. `@yourcrm/events` has no
 * sequence event group and this module may not add one (nor may it emit
 * string literals, which would fork the event vocabulary). So P0 emits NO
 * sequence domain events and AUDITS every mutation instead — the same call
 * the unified-inbox module made for `conversation.*`. The `events` port
 * stays wired in `types.ts`, so adding the constants upstream and the four
 * `emit` calls here is a one-file change. Events this module CONSUMES are
 * unaffected: they come from the existing `CommunicationEvents` constants.
 */

/* --------------------------------- errors --------------------------------- */

export class SalesSequenceNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`sequence ${id} not found`)
    this.name = "SalesSequenceNotFoundError"
  }
}

export class SalesSequenceEnrollmentNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`sequence enrollment ${id} not found`)
    this.name = "SalesSequenceEnrollmentNotFoundError"
  }
}

export class SalesSequenceNotEnrollableError extends Error {
  readonly code = "SEQUENCE_NOT_ENROLLABLE"
  constructor(message: string) {
    super(message)
    this.name = "SalesSequenceNotEnrollableError"
  }
}

/** The person opted out (or hard-bounced) somewhere in this workspace. */
export class SalesSequenceSuppressedError extends Error {
  readonly code = "SEQUENCE_CONTACT_SUPPRESSED"
  constructor(reason: string) {
    super(`this contact is suppressed from sequences (${reason})`)
    this.name = "SalesSequenceSuppressedError"
  }
}

export class SalesSequenceStepError extends Error {
  readonly code = "SEQUENCE_STEP_FAILED"
  constructor(message: string) {
    super(message)
    this.name = "SalesSequenceStepError"
  }
}

/* -------------------------------- helpers --------------------------------- */

/**
 * Correlation-id convention. Every step executes with `correlationId` set
 * to `seqenr:<enrollmentId>`, so the email it sends, the audit row it
 * writes and the thread it lands on are all greppable from one id — and so
 * the inbound reply that later stops the enrollment can be traced back to
 * the send that provoked it.
 */
export const SALES_SEQUENCE_CORRELATION_PREFIX = "seqenr:"

export function salesSequenceCorrelationId(enrollmentId: string): string {
  return `${SALES_SEQUENCE_CORRELATION_PREFIX}${enrollmentId}`
}

export function parseSalesSequenceCorrelationId(correlationId?: string | null): string | null {
  if (typeof correlationId !== "string") return null
  if (!correlationId.startsWith(SALES_SEQUENCE_CORRELATION_PREFIX)) return null
  const id = correlationId.slice(SALES_SEQUENCE_CORRELATION_PREFIX.length)
  return id === "" ? null : id
}

const TEMPLATE_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g

/**
 * `{{field}}` personalisation, restricted to the variables the engine can
 * vouch for (the enrolled contact and the sequence). Unknown placeholders
 * render empty rather than leaking `{{firstName}}` into a prospect's
 * inbox, and object values never interpolate.
 */
export function renderSalesSequenceTemplate(
  template: string,
  variables: Record<string, unknown>,
): string {
  return template.replace(TEMPLATE_PATTERN, (_match, field: string) => {
    const value = variables[field]
    if (value === null || value === undefined) return ""
    if (typeof value === "object") return ""
    return String(value)
  })
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Total delay a step imposes, in milliseconds. */
function stepDelayMs(step: SalesSequenceStepRecord): number {
  const days = Math.max(0, numberOr(step.waitDays, 0))
  const hours = Math.max(0, numberOr(step.waitHours, 0))
  return (days * 24 + hours) * 60 * 60 * 1000
}

/** Envelope shape the exit watcher accepts (restated, no events import). */
export type SalesSequenceInboundEnvelope = {
  event: string
  workspaceId: string
  entityType?: string
  entityId?: string
  after?: unknown
  correlationId?: string
}

function readAfterField(envelope: SalesSequenceInboundEnvelope, key: string): unknown {
  const after = envelope.after
  if (typeof after !== "object" || after === null || Array.isArray(after)) return undefined
  return (after as Record<string, unknown>)[key]
}

/* -------------------------------- service --------------------------------- */

export function createSalesSequenceService(deps: SalesSequenceServiceDeps) {
  const now = deps.now ?? (() => new Date())

  /* ------------------------------ authoring ------------------------------ */

  async function list(
    ctx: SalesSequenceServiceContext,
    rawQuery: unknown,
  ): Promise<SalesSequenceListResult> {
    requirePermission(salesSequencePermission(ctx, "read"))
    const query = salesSequenceQuerySchema.parse(rawQuery)
    return deps.store.list(ctx.workspaceId, query)
  }

  async function get(
    ctx: SalesSequenceServiceContext,
    id: string,
  ): Promise<SalesSequenceWithSteps> {
    requirePermission(salesSequencePermission(ctx, "read"))
    const sequence = await deps.store.findById(ctx.workspaceId, id)
    if (!sequence) throw new SalesSequenceNotFoundError(id)
    const steps = await deps.store.listSteps(ctx.workspaceId, id)
    return { sequence, steps }
  }

  async function create(
    ctx: SalesSequenceServiceContext,
    rawInput: unknown,
  ): Promise<SalesSequenceRecord> {
    requirePermission(salesSequencePermission(ctx, "create"))
    const input = createSalesSequenceSchema.parse(rawInput)
    // A sequence sends AS its owner, so letting an author hand ownership to
    // a more privileged colleague would be an escalation. Ownership is the
    // author unless an admin says otherwise.
    const ownerId =
      input.ownerId == null || input.ownerId === ctx.actorId
        ? ctx.actorId
        : assertMayAssignOwner(ctx, input.ownerId)
    const sequence = await deps.store.create(
      ctx.workspaceId,
      { ...input, ownerId, status: "draft" },
      ctx.actorId,
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: SALES_SEQUENCE_OBJECT,
      recordId: sequence.id,
      after: sequence,
      correlationId: ctx.correlationId,
    })
    return sequence
  }

  function assertMayAssignOwner(ctx: SalesSequenceServiceContext, ownerId: string): string {
    requirePermission(salesSequencePermission(ctx, "admin"))
    return ownerId
  }

  async function update(
    ctx: SalesSequenceServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<SalesSequenceRecord> {
    requirePermission(salesSequencePermission(ctx, "update"))
    const patch = updateSalesSequenceSchema.parse(rawPatch)
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new SalesSequenceNotFoundError(id)
    const ownerId =
      patch.ownerId == null || patch.ownerId === ctx.actorId
        ? patch.ownerId
        : assertMayAssignOwner(ctx, patch.ownerId)
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      { ...patch, ...(ownerId == null ? {} : { ownerId }) },
      ctx.actorId,
    )
    if (!after) throw new SalesSequenceNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: SALES_SEQUENCE_OBJECT,
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /**
   * Activate / pause / archive.
   *
   * Activating is the privileged act — it is what makes the sequence start
   * putting mail on the wire — so it needs `send_external`, the permission
   * `@yourcrm/permissions` already defines for that. Pausing and drafting
   * only need `update`: stopping a running sequence must never be harder
   * than starting it. See `access.ts` for why this differs from the
   * automation engine's `run_automation` gate.
   *
   * Archiving also STOPS every live enrollment: a retired sequence that
   * quietly kept emailing would be the exact failure this module exists to
   * prevent.
   */
  async function setStatus(
    ctx: SalesSequenceServiceContext,
    id: string,
    rawStatus: unknown,
  ): Promise<SalesSequenceRecord> {
    const status: SalesSequenceStatusValue = salesSequenceStatusSchema.parse(rawStatus)
    requirePermission(
      salesSequencePermission(ctx, status === "active" ? "send_external" : "update"),
    )
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new SalesSequenceNotFoundError(id)

    if (status === "active") {
      const steps = await deps.store.listSteps(ctx.workspaceId, id)
      if (steps.length === 0) {
        throw new SalesSequenceNotEnrollableError("a sequence needs at least one step to activate")
      }
    }

    const after = await deps.store.update(ctx.workspaceId, id, { status }, ctx.actorId)
    if (!after) throw new SalesSequenceNotFoundError(id)

    if (status === "archived") {
      await stopEveryEnrollment(ctx, id, "sequence_archived")
    }

    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: status === "active" ? "activate" : status,
      object: SALES_SEQUENCE_OBJECT,
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function softDelete(
    ctx: SalesSequenceServiceContext,
    id: string,
  ): Promise<SalesSequenceRecord> {
    requirePermission(salesSequencePermission(ctx, "delete"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new SalesSequenceNotFoundError(id)
    // Deleting a sequence must stop its drips before the definition goes
    // away, not after.
    await stopEveryEnrollment(ctx, id, "sequence_archived")
    await deps.store.softDelete(ctx.workspaceId, id, ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: SALES_SEQUENCE_OBJECT,
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function restore(
    ctx: SalesSequenceServiceContext,
    id: string,
  ): Promise<SalesSequenceRecord> {
    requirePermission(salesSequencePermission(ctx, "update"))
    await deps.store.restore(ctx.workspaceId, id)
    const after = await deps.store.findById(ctx.workspaceId, id)
    if (!after) throw new SalesSequenceNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "restore",
      object: SALES_SEQUENCE_OBJECT,
      recordId: id,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /* -------------------------------- steps -------------------------------- */

  async function listSteps(
    ctx: SalesSequenceServiceContext,
    sequenceId: string,
  ): Promise<SalesSequenceStepRecord[]> {
    requirePermission(salesSequencePermission(ctx, "read"))
    return deps.store.listSteps(ctx.workspaceId, sequenceId)
  }

  /**
   * Replace the ordered step list. The editor saves a list, not a diff, so
   * the stored `step_index` is re-derived from array position.
   *
   * Editing a LIVE sequence is allowed on purpose — sales teams fix a typo
   * in step 3 while step 1 is in flight — and it is safe because
   * idempotency is keyed on (enrollment, step index): a step somebody has
   * already passed is never re-executed, whatever it now contains.
   */
  async function replaceSteps(
    ctx: SalesSequenceServiceContext,
    sequenceId: string,
    rawInput: unknown,
  ): Promise<SalesSequenceStepRecord[]> {
    requirePermission(salesSequencePermission(ctx, "update"))
    const input = replaceSalesSequenceStepsSchema.parse(rawInput)
    const sequence = await deps.store.findById(ctx.workspaceId, sequenceId)
    if (!sequence) throw new SalesSequenceNotFoundError(sequenceId)
    const before = await deps.store.listSteps(ctx.workspaceId, sequenceId)
    const steps = await deps.store.replaceSteps(
      ctx.workspaceId,
      sequenceId,
      input.steps.map(toSalesSequenceStepDraft),
      ctx.actorId,
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update_steps",
      object: SALES_SEQUENCE_OBJECT,
      recordId: sequenceId,
      before: { stepCount: before.length },
      after: { stepCount: steps.length, stepTypes: steps.map((s) => s.stepType) },
      correlationId: ctx.correlationId,
    })
    return steps
  }

  /* ----------------------------- enrollments ----------------------------- */

  /**
   * Enrol one person. Idempotent on (sequence, person): a second call
   * returns the existing enrollment with `created: false` rather than
   * starting a parallel drip.
   *
   * Three gates before anybody is added:
   *   1. the caller may create enrollments;
   *   2. the sequence is `active` and has steps;
   *   3. the contact is not SUPPRESSED — an unsubscribe or hard bounce
   *      anywhere in this workspace blocks enrolment everywhere in it.
   */
  async function enroll(
    ctx: SalesSequenceServiceContext,
    sequenceId: string,
    rawInput: unknown,
  ): Promise<SalesSequenceEnrollResult> {
    requirePermission(salesSequencePermission(ctx, "create", SALES_SEQUENCE_ENROLLMENT_OBJECT))
    const input = enrollInSalesSequenceSchema.parse(rawInput)
    const sequence = await deps.store.findById(ctx.workspaceId, sequenceId)
    if (!sequence) throw new SalesSequenceNotFoundError(sequenceId)
    if (sequence.status !== "active") {
      throw new SalesSequenceNotEnrollableError(
        `sequence ${sequenceId} is ${String(sequence.status)}; activate it before enrolling anybody`,
      )
    }
    const steps = await deps.store.listSteps(ctx.workspaceId, sequenceId)
    if (steps.length === 0) {
      throw new SalesSequenceNotEnrollableError(`sequence ${sequenceId} has no steps`)
    }

    // The address comes from the PEOPLE module's own contract, never from
    // an id this module guessed at.
    const contact = await deps.resolveContact(ctx.workspaceId, input.personId)
    if (!contact) {
      throw new SalesSequenceNotEnrollableError(`person ${input.personId} was not found`)
    }
    const emailAddress = (input.emailAddress ?? contact.emailAddress ?? "").trim().toLowerCase()
    if (emailAddress === "") {
      throw new SalesSequenceNotEnrollableError(
        `person ${input.personId} has no email address to send to`,
      )
    }

    const suppression = await deps.store.findSuppression(ctx.workspaceId, {
      personId: input.personId,
      emailAddress,
    })
    if (suppression) {
      throw new SalesSequenceSuppressedError(String(suppression.exitReason ?? "unsubscribed"))
    }

    const firstStep = steps[0]
    const startAt = new Date(now().getTime() + (firstStep ? stepDelayMs(firstStep) : 0))
    const { enrollment, created } = await deps.store.enrollPerson(ctx.workspaceId, {
      sequenceId,
      personId: input.personId,
      dealId: input.dealId ?? null,
      emailAddress,
      enrolledBy: ctx.actorId,
      nextRunAt: startAt,
    })

    // IDEMPOTENCY: this person is already in the sequence. Do not queue a
    // second first step — the existing drip owns them.
    if (!created) return { enrollment, created: false }

    await deps.store.markEnrolled(ctx.workspaceId, sequenceId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "enroll",
      object: SALES_SEQUENCE_ENROLLMENT_OBJECT,
      recordId: enrollment.id,
      after: {
        sequenceId,
        personId: input.personId,
        emailAddress,
        firstStepAt: startAt.toISOString(),
      },
      correlationId: ctx.correlationId,
    })

    await enqueueStep(enrollment, 0, startAt, ctx.correlationId)
    return { enrollment, created: true }
  }

  async function listEnrollments(
    ctx: SalesSequenceServiceContext,
    rawQuery: unknown,
  ): Promise<SalesSequenceEnrollmentListResult> {
    requirePermission(salesSequencePermission(ctx, "read", SALES_SEQUENCE_ENROLLMENT_OBJECT))
    const query = salesSequenceEnrollmentQuerySchema.parse(rawQuery)
    return deps.store.listEnrollments(ctx.workspaceId, query)
  }

  async function getEnrollment(
    ctx: SalesSequenceServiceContext,
    id: string,
  ): Promise<SalesSequenceEnrollmentWithRuns> {
    requirePermission(salesSequencePermission(ctx, "read", SALES_SEQUENCE_ENROLLMENT_OBJECT))
    const enrollment = await deps.store.findEnrollmentById(ctx.workspaceId, id)
    if (!enrollment) throw new SalesSequenceEnrollmentNotFoundError(id)
    const runs = await deps.store.listStepRuns(ctx.workspaceId, id)
    return { enrollment, runs }
  }

  /** Pause one person's drip without ending it. Resumable. */
  async function pauseEnrollment(
    ctx: SalesSequenceServiceContext,
    id: string,
  ): Promise<SalesSequenceEnrollmentRecord> {
    requirePermission(salesSequencePermission(ctx, "update", SALES_SEQUENCE_ENROLLMENT_OBJECT))
    const before = await deps.store.findEnrollmentById(ctx.workspaceId, id)
    if (!before) throw new SalesSequenceEnrollmentNotFoundError(id)
    const after =
      (await deps.store.updateEnrollment(ctx.workspaceId, id, {
        status: "paused",
        nextRunAt: null,
      })) ?? before
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "pause",
      object: SALES_SEQUENCE_ENROLLMENT_OBJECT,
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /**
   * Resume a paused drip and re-queue its current step. A STOPPED
   * enrollment is not resumable: "they replied" is not a pause.
   */
  async function resumeEnrollment(
    ctx: SalesSequenceServiceContext,
    id: string,
  ): Promise<SalesSequenceEnrollmentRecord> {
    requirePermission(salesSequencePermission(ctx, "update", SALES_SEQUENCE_ENROLLMENT_OBJECT))
    const before = await deps.store.findEnrollmentById(ctx.workspaceId, id)
    if (!before) throw new SalesSequenceEnrollmentNotFoundError(id)
    if (before.status !== "paused") {
      throw new SalesSequenceNotEnrollableError(
        `enrollment ${id} is ${String(before.status)} and cannot be resumed`,
      )
    }
    const runAt = now()
    const after =
      (await deps.store.updateEnrollment(ctx.workspaceId, id, {
        status: "active",
        exitReason: null,
        nextRunAt: runAt,
      })) ?? before
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "resume",
      object: SALES_SEQUENCE_ENROLLMENT_OBJECT,
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    await enqueueStep(after, numberOr(after.currentStepIndex, 0), runAt, ctx.correlationId)
    return after
  }

  /** Manual removal (or a hand-recorded unsubscribe). Terminal. */
  async function stopEnrollment(
    ctx: SalesSequenceServiceContext,
    id: string,
    rawInput: unknown,
  ): Promise<SalesSequenceEnrollmentRecord> {
    requirePermission(salesSequencePermission(ctx, "update", SALES_SEQUENCE_ENROLLMENT_OBJECT))
    const input = stopSalesSequenceEnrollmentSchema.parse(rawInput ?? {})
    const before = await deps.store.findEnrollmentById(ctx.workspaceId, id)
    if (!before) throw new SalesSequenceEnrollmentNotFoundError(id)
    const after = await exitEnrollment(before, input.reason, ctx.actorId, ctx.correlationId)
    return after
  }

  /**
   * Workspace-wide opt-out. Stops every live enrollment for this contact
   * and, because `findSuppression` reads exit reasons, permanently blocks
   * re-enrolment anywhere in the workspace.
   */
  async function unsubscribe(
    ctx: SalesSequenceServiceContext,
    rawInput: unknown,
  ): Promise<SalesSequenceExitResult> {
    requirePermission(salesSequencePermission(ctx, "update", SALES_SEQUENCE_ENROLLMENT_OBJECT))
    const input = unsubscribeFromSalesSequencesSchema.parse(rawInput)
    const matches = await deps.store.findActiveEnrollmentsByTarget(ctx.workspaceId, {
      personId: input.personId ?? null,
      emailAddress: input.emailAddress ?? null,
    })
    const stopped: SalesSequenceExitDecision[] = []
    for (const enrollment of matches) {
      await exitEnrollment(enrollment, "unsubscribed", ctx.actorId, ctx.correlationId)
      stopped.push({
        enrollmentId: enrollment.id,
        sequenceId: enrollment.sequenceId,
        reason: "unsubscribed",
      })
    }
    return { event: "unsubscribe", reason: "unsubscribed", stopped }
  }

  async function stats(
    ctx: SalesSequenceServiceContext,
    sequenceId: string,
  ): Promise<SalesSequenceStats> {
    requirePermission(salesSequencePermission(ctx, "read"))
    const sequence = await deps.store.findById(ctx.workspaceId, sequenceId)
    if (!sequence) throw new SalesSequenceNotFoundError(sequenceId)
    return deps.store.stats(ctx.workspaceId, sequenceId)
  }

  /* ------------------------------ exit path ------------------------------ */

  /**
   * THE EXIT. One write flips the enrollment out of `active`, and because
   * `executeStep` reads that state first, every step already queued for
   * this person becomes a no-op. No cancellation, no race, no "we managed
   * to pull the job in time".
   */
  async function exitEnrollment(
    enrollment: SalesSequenceEnrollmentRecord,
    reason: SalesSequenceExitReasonValue,
    actorId: string | null,
    correlationId?: string,
  ): Promise<SalesSequenceEnrollmentRecord> {
    const at = now()
    const after =
      (await deps.store.updateEnrollment(enrollment.workspaceId, enrollment.id, {
        status: reason === "completed" ? "completed" : reason === "failed" ? "failed" : "stopped",
        exitReason: reason,
        nextRunAt: null,
        ...(reason === "completed" ? { completedAt: at } : { stoppedAt: at }),
      })) ?? enrollment
    await deps.audit({
      workspaceId: enrollment.workspaceId,
      actorId,
      action: reason === "completed" ? "complete" : "stop",
      object: SALES_SEQUENCE_ENROLLMENT_OBJECT,
      recordId: enrollment.id,
      before: { status: enrollment.status, currentStepIndex: enrollment.currentStepIndex },
      after: { status: after.status, exitReason: reason },
      correlationId: correlationId ?? salesSequenceCorrelationId(enrollment.id),
      source: actorId === null ? "integration" : "user",
    })
    return after
  }

  async function stopEveryEnrollment(
    ctx: SalesSequenceServiceContext,
    sequenceId: string,
    reason: SalesSequenceExitReasonValue,
  ): Promise<void> {
    const live = await deps.store.listEnrollments(ctx.workspaceId, {
      sequenceId,
      status: "active",
      limit: 200,
    })
    for (const enrollment of live.data) {
      await exitEnrollment(enrollment, reason, ctx.actorId, ctx.correlationId)
    }
  }

  /**
   * Entry point from the event bus. Turns an inbound reply or bounce into
   * an exit.
   *
   * Not a user-callable method: it carries no caller context because there
   * is no caller — the prospect caused it. Nothing here writes to a
   * business record outside this module.
   *
   * MATCHING. `email.received` carries the email module's message summary,
   * whose `threadId` is the thread our step created; the enrollment stores
   * that same thread id when its first email goes out. Person id and
   * address are also tried, because a provider that only hands us an
   * address must still be able to stop the sequence — over-matching here
   * costs a stopped drip, under-matching costs a prospect who replied and
   * got emailed anyway.
   */
  async function handleInboundEvent(
    envelope: SalesSequenceInboundEnvelope,
  ): Promise<SalesSequenceExitResult> {
    const reason = salesSequenceExitReasonForEvent(envelope.event)
    if (reason === null) return { event: envelope.event, reason: null, stopped: [] }

    // Our own outbound copy lands on the same thread. Only a message FROM
    // the prospect is a reply.
    if (
      reason === "replied" &&
      !isSalesSequenceInboundDirection(readAfterField(envelope, "direction"))
    ) {
      return { event: envelope.event, reason, stopped: [] }
    }

    const threadId = stringOrNull(readAfterField(envelope, "threadId"))
    const personId =
      stringOrNull(readAfterField(envelope, "personId")) ??
      (envelope.entityType === "person" ? stringOrNull(envelope.entityId) : null)
    const emailAddress = stringOrNull(readAfterField(envelope, "fromAddress"))
    if (threadId === null && personId === null && emailAddress === null) {
      return { event: envelope.event, reason, stopped: [] }
    }

    const matches = await deps.store.findActiveEnrollmentsByTarget(envelope.workspaceId, {
      threadId,
      personId,
      emailAddress,
    })
    const stopped: SalesSequenceExitDecision[] = []
    for (const enrollment of matches) {
      // The sequence decides whether THIS signal ends it; `unsubscribed`
      // and `removed` are unconditional and never arrive here.
      const sequence = await deps.store.findById(envelope.workspaceId, enrollment.sequenceId)
      const honours =
        reason === "replied" ? sequence?.exitOnReply !== false : sequence?.exitOnBounce !== false
      if (!honours) continue
      await exitEnrollment(enrollment, reason, null, envelope.correlationId)
      stopped.push({
        enrollmentId: enrollment.id,
        sequenceId: enrollment.sequenceId,
        reason,
      })
    }
    return { event: envelope.event, reason, stopped }
  }

  /* ------------------------------ execution ------------------------------ */

  /**
   * Execute one due step. Called by the worker job through the queue seam,
   * never from a request handler.
   *
   * No caller context: the enrollment already names the sequence whose
   * owner it inherits from, and taking one would be the escalation hole
   * this design exists to close.
   *
   * The order of the guards is the contract:
   *   1. enrollment still `active`?  -> EXIT CONDITIONS
   *   2. the step we were told to run is still the current one?
   *   3. sequence still `active`?
   *   4. owner still a member, and allowed to do this?  -> INHERITANCE
   *   5. claim (enrollment, index)   -> IDEMPOTENCY
   *   6. only now, act.
   */
  async function executeStep(
    workspaceId: string,
    enrollmentId: string,
    stepIndex: number,
  ): Promise<SalesSequenceStepOutcome> {
    const enrollment = await deps.store.findEnrollmentById(workspaceId, enrollmentId)
    if (!enrollment) throw new SalesSequenceEnrollmentNotFoundError(enrollmentId)

    // (1) THE EXIT CHECK. Replied, bounced, unsubscribed, removed, paused,
    // completed — all of them land here and all of them do nothing. A job
    // queued before the prospect replied cannot send.
    if (enrollment.status !== "active") {
      return {
        enrollmentId,
        stepIndex,
        outcome: "enrollment_not_active",
        status: enrollment.status,
      }
    }

    // (2) A stale job (the step was already run and the cursor moved on, or
    // somebody resumed the enrollment at a different point).
    if (numberOr(enrollment.currentStepIndex, 0) !== stepIndex) {
      return { enrollmentId, stepIndex, outcome: "stale_step", status: enrollment.status }
    }

    const sequence = await deps.store.findById(workspaceId, enrollment.sequenceId)
    if (!sequence) {
      const failed = await exitEnrollment(
        enrollment,
        "failed",
        null,
        salesSequenceCorrelationId(enrollmentId),
      )
      return {
        enrollmentId,
        stepIndex,
        outcome: "failed",
        status: failed.status,
        error: `sequence ${enrollment.sequenceId} no longer exists`,
      }
    }
    // (3) Pausing the SEQUENCE pauses every drip, without touching each
    // enrollment: the step simply does not run, and resuming re-queues.
    if (sequence.status !== "active") {
      return { enrollmentId, stepIndex, outcome: "sequence_not_active", status: enrollment.status }
    }

    const steps = await deps.store.listSteps(workspaceId, enrollment.sequenceId)
    const step = steps[stepIndex]
    if (!step) {
      // Ran off the end: every step is done.
      const done = await completeEnrollment(enrollment)
      return { enrollmentId, stepIndex, outcome: "completed", status: done.status }
    }

    // (4) PERMISSION INHERITANCE: resolve the owner's role NOW, not when
    // the sequence was written, and refuse outright if they have left.
    const ownerId = stringOrNull(sequence.ownerId) ?? stringOrNull(sequence.createdBy) ?? ""
    let actorRole: string
    try {
      const resolved = ownerId === "" ? null : await deps.resolveActorRole(workspaceId, ownerId)
      assertSalesSequenceActorResolved(workspaceId, ownerId, resolved)
      actorRole = resolved
    } catch (err) {
      return failStep(enrollment, stepIndex, errorMessage(err))
    }

    const actorCtx = {
      workspaceId,
      actorId: ownerId,
      role: actorRole,
      correlationId: salesSequenceCorrelationId(enrollment.id),
    }
    const stepType = String(step.stepType)

    // (5) IDEMPOTENCY: claim the slot BEFORE doing anything observable. A
    // retried job loses the insert and must not send.
    const { run, claimed } = await deps.store.claimStepRun(workspaceId, {
      enrollmentId: enrollment.id,
      stepIndex,
      stepType,
      stepId: step.id,
      actorId: ownerId,
      actorRole,
    })
    if (!claimed) {
      // A previous attempt owns this step. Do not re-send; just make sure
      // the cursor is not stuck behind a finished attempt.
      const advanced = await advance(enrollment, stepIndex, steps)
      return {
        enrollmentId,
        stepIndex,
        outcome: "already_attempted",
        status: advanced.status,
      }
    }

    // (6) Act.
    try {
      assertSalesSequenceStepAllowed(actorCtx, stepType as SalesSequenceStepTypeValue)
      const result = await performStep(actorCtx, step, enrollment)
      await deps.store.completeStepRun(workspaceId, run.id, { status: "succeeded", result })
      if (stepType === "email") {
        await deps.store.incrementSentCount(workspaceId, enrollment.id)
        const threadId = stringOrNull(result.threadId)
        if (threadId !== null && stringOrNull(enrollment.threadId) === null) {
          // Remember the thread so an inbound reply can find this drip.
          await deps.store.updateEnrollment(workspaceId, enrollment.id, { threadId })
        }
      }
      await deps.audit({
        workspaceId,
        actorId: ownerId,
        action: "step",
        object: SALES_SEQUENCE_ENROLLMENT_OBJECT,
        recordId: enrollment.id,
        after: { stepIndex, stepType, actorRole, result },
        correlationId: actorCtx.correlationId,
        source: "automation",
      })
      const advanced = await advance(enrollment, stepIndex, steps)
      return {
        enrollmentId,
        stepIndex,
        outcome: advanced.status === "completed" ? "completed" : "executed",
        status: advanced.status,
      }
    } catch (err) {
      const message = errorMessage(err)
      await deps.store.completeStepRun(workspaceId, run.id, {
        status: "failed",
        error: message,
      })
      return failStep(enrollment, stepIndex, message, err instanceof PermissionDeniedError)
    }
  }

  async function performStep(
    actorCtx: SalesSequenceServiceContext,
    step: SalesSequenceStepRecord,
    enrollment: SalesSequenceEnrollmentRecord,
  ): Promise<Record<string, unknown>> {
    const variables = templateVariablesOf(enrollment)
    switch (step.stepType) {
      case "email": {
        const config = storedSalesSequenceEmailConfigSchema.parse(step.config)
        const sent = await deps.executor.sendSequenceEmail(actorCtx, {
          to: enrollment.emailAddress,
          subject: renderSalesSequenceTemplate(config.subject, variables),
          bodyText: renderSalesSequenceTemplate(config.bodyText, variables),
          bodyHtml:
            config.bodyHtml == null
              ? null
              : renderSalesSequenceTemplate(config.bodyHtml, variables),
          threadId: stringOrNull(enrollment.threadId),
          personId: enrollment.personId,
          dealId: stringOrNull(enrollment.dealId),
        })
        return { messageId: sent.messageId, threadId: sent.threadId }
      }
      case "task": {
        const config = storedSalesSequenceTaskConfigSchema.parse(step.config)
        const created = await deps.executor.createSequenceTask(actorCtx, {
          title: renderSalesSequenceTemplate(config.title, variables),
          description:
            config.description == null
              ? null
              : renderSalesSequenceTemplate(config.description, variables),
          priority: config.priority ?? null,
          dueDate: config.dueInDays == null ? null : dueDateIn(config.dueInDays),
          assigneeId: config.assigneeId ?? actorCtx.actorId,
          personId: enrollment.personId,
          dealId: stringOrNull(enrollment.dealId),
        })
        return { taskId: created.taskId }
      }
      case "wait":
        // A wait step's whole effect is the delay already applied before it
        // was queued. Recording the run is what makes it idempotent.
        return { waited: true }
      default:
        throw new SalesSequenceStepError(`unknown step type '${String(step.stepType)}'`)
    }
  }

  /** Variables `{{...}}` may reference. Deliberately small and verifiable. */
  function templateVariablesOf(enrollment: SalesSequenceEnrollmentRecord): Record<string, unknown> {
    return {
      email: enrollment.emailAddress,
      personId: enrollment.personId,
      stepNumber: numberOr(enrollment.currentStepIndex, 0) + 1,
    }
  }

  function dueDateIn(days: number): string {
    return new Date(now().getTime() + days * 24 * 60 * 60 * 1000).toISOString()
  }

  /** Move the cursor on and queue the next step, or finish the enrollment. */
  async function advance(
    enrollment: SalesSequenceEnrollmentRecord,
    stepIndex: number,
    steps: SalesSequenceStepRecord[],
  ): Promise<SalesSequenceEnrollmentRecord> {
    const nextIndex = stepIndex + 1
    const nextStep = steps[nextIndex]
    if (!nextStep) return completeEnrollment(enrollment)

    const runAt = new Date(now().getTime() + stepDelayMs(nextStep))
    const moved =
      (await deps.store.updateEnrollment(enrollment.workspaceId, enrollment.id, {
        currentStepIndex: nextIndex,
        nextRunAt: runAt,
        lastStepAt: now(),
      })) ?? enrollment
    try {
      await enqueueStep(moved, nextIndex, runAt, salesSequenceCorrelationId(enrollment.id))
    } catch (err) {
      // The cursor has already moved, so a silent enqueue failure would
      // strand the prospect mid-sequence. Make it visible instead.
      const failed =
        (await deps.store.updateEnrollment(enrollment.workspaceId, enrollment.id, {
          status: "failed",
          exitReason: "failed",
          nextRunAt: null,
          error: `could not queue step ${nextIndex}: ${errorMessage(err)}`,
        })) ?? moved
      return failed
    }
    return moved
  }

  async function completeEnrollment(
    enrollment: SalesSequenceEnrollmentRecord,
  ): Promise<SalesSequenceEnrollmentRecord> {
    return exitEnrollment(enrollment, "completed", null, salesSequenceCorrelationId(enrollment.id))
  }

  async function failStep(
    enrollment: SalesSequenceEnrollmentRecord,
    stepIndex: number,
    message: string,
    forbidden = false,
  ): Promise<SalesSequenceStepOutcome> {
    const failed =
      (await deps.store.updateEnrollment(enrollment.workspaceId, enrollment.id, {
        status: "failed",
        exitReason: "failed",
        nextRunAt: null,
        error: message,
        stoppedAt: now(),
      })) ?? enrollment
    await deps.audit({
      workspaceId: enrollment.workspaceId,
      actorId: null,
      action: "step_failed",
      object: SALES_SEQUENCE_ENROLLMENT_OBJECT,
      recordId: enrollment.id,
      after: { stepIndex, error: message, forbidden },
      correlationId: salesSequenceCorrelationId(enrollment.id),
      source: "automation",
    })
    return {
      enrollmentId: enrollment.id,
      stepIndex,
      outcome: "failed",
      status: failed.status,
      error: message,
    }
  }

  async function enqueueStep(
    enrollment: SalesSequenceEnrollmentRecord,
    stepIndex: number,
    runAt: Date,
    correlationId?: string,
  ): Promise<void> {
    await deps.queue.enqueueSequenceStep({
      workspaceId: enrollment.workspaceId,
      sequenceId: enrollment.sequenceId,
      enrollmentId: enrollment.id,
      stepIndex,
      runAt,
      ...(correlationId === undefined ? {} : { correlationId }),
    })
  }

  return {
    list,
    get,
    create,
    update,
    setStatus,
    softDelete,
    restore,
    listSteps,
    replaceSteps,
    enroll,
    listEnrollments,
    getEnrollment,
    pauseEnrollment,
    resumeEnrollment,
    stopEnrollment,
    unsubscribe,
    stats,
    handleInboundEvent,
    executeStep,
  }
}

export type SalesSequenceService = ReturnType<typeof createSalesSequenceService>

/**
 * Subscribe the exit watcher to the in-process event bus. This is what
 * makes "stop on reply" real rather than aspirational.
 *
 * WIRING NOTE: the application bootstrap (`apps/api/src/index.ts`) owns
 * this call — route factories must not subscribe, because route
 * construction happens in tests that emit unrelated events on the shared
 * bus. `apps/api/src/routes/modules/sequences.ts` re-exports a bound
 * version (`subscribeSalesSequenceExitWatcher`) so the bootstrap is one
 * line.
 *
 * Returns the unsubscribe function.
 */
export function subscribeSalesSequenceExits(
  bus: {
    on(event: string, handler: (event: SalesSequenceInboundEnvelope) => Promise<void>): () => void
  },
  service: Pick<SalesSequenceService, "handleInboundEvent">,
  onError: (err: unknown, event: SalesSequenceInboundEnvelope) => void = () => {},
): () => void {
  return bus.on("*", async (event: SalesSequenceInboundEnvelope) => {
    // A failing exit check must never fail the inbound write that
    // triggered it — but it MUST be loud, because a missed exit is the one
    // bug this module cannot tolerate.
    try {
      await service.handleInboundEvent(event)
    } catch (err) {
      onError(err, event)
    }
  })
}
