import { AutomationEvents, createEvent, getEventBus } from "@yourcrm/events"
import { PermissionDeniedError, requirePermission } from "@yourcrm/permissions"
import {
  assertWorkflowActionAllowed,
  assertWorkflowActorResolved,
  workflowPermission,
  WORKFLOW_OBJECT,
} from "./access"
import {
  matchesWorkflowConditions,
  matchesWorkflowTrigger,
  renderWorkflowTemplate,
  toWorkflowConditionRecord,
} from "./conditions"
import {
  createWorkflowSchema,
  runWorkflowSchema,
  updateWorkflowSchema,
  workflowActionSchema,
  workflowQuerySchema,
  workflowRunQuerySchema,
  WORKFLOW_MAX_CASCADE_DEPTH,
  type WorkflowActionInput,
} from "./schemas"
import type {
  WorkflowActionTarget,
  WorkflowAutomationServiceContext,
  WorkflowAutomationServiceDeps,
  WorkflowDispatchDecision,
  WorkflowDispatchResult,
  WorkflowListResult,
  WorkflowRecord,
  WorkflowRunListResult,
  WorkflowRunOutcome,
  WorkflowRunRecord,
  WorkflowRunWithSteps,
  WorkflowTriggerEnvelope,
} from "./types"

/**
 * Workflow automation service (spec 25-automation, P0).
 *
 * An ENGINE, not a CRUD module: seventeen modules already emit domain
 * events, and this turns "when X happens, do Y" into stored data plus a
 * queued run. It never reimplements another module's rules — every action
 * goes through that module's own contract via `WorkflowActionExecutorPort`.
 *
 * THE THREE PROPERTIES
 * --------------------
 * 1. IDEMPOTENCY. A run is keyed on the triggering event id:
 *    `store.createRun` inserts against the UNIQUE
 *    (workflow_id, trigger_event_id) index and reports `created: false` on
 *    redelivery, in which case nothing is enqueued. Within a run, each
 *    action claims its own (run_id, step_index) row before executing, so a
 *    retried job resumes instead of re-applying. Re-executing a run that
 *    already reached a terminal status is a no-op.
 *
 * 2. PERMISSION INHERITANCE. A run executes as the workflow's OWNER. The
 *    owner's role is re-read live (`resolveActorRole`) at execution time,
 *    the run is refused outright if they are no longer a member, and every
 *    single action calls `requirePermission()` against that role before it
 *    runs (`access.ts`). A denial fails the step, fails the run and is
 *    recorded — it never falls through to the executor.
 *
 * 3. LOOP PROTECTION. Actions emit events; those events come back through
 *    `dispatch`. Each run carries a `depth`, derived from the parent run
 *    named by the triggering event's correlation id, and a run past
 *    `WORKFLOW_MAX_CASCADE_DEPTH` is recorded as `skipped` and never
 *    enqueued. Engine events (`workflow.*`) are not triggerable at all.
 *
 * Nothing here touches BullMQ, Redis or Postgres: runs leave through
 * `WorkflowRunQueuePort` and state lands through `WorkflowAutomationStore`.
 */

export class WorkflowNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`workflow ${id} not found`)
    this.name = "WorkflowNotFoundError"
  }
}

export class WorkflowRunNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`workflow run ${id} not found`)
    this.name = "WorkflowRunNotFoundError"
  }
}

export class WorkflowActionError extends Error {
  readonly code = "WORKFLOW_ACTION_FAILED"
  constructor(message: string) {
    super(message)
    this.name = "WorkflowActionError"
  }
}

/**
 * Correlation-id convention that carries the cascade chain.
 *
 * Every action a run performs executes with `correlationId` set to
 * `wfrun:<runId>`. The events those actions emit inherit it, so when one
 * comes back through `dispatch` the engine knows which run caused it and
 * can compute the next depth. It also makes an automation's whole blast
 * radius greppable in the audit log from one id.
 */
export const WORKFLOW_RUN_CORRELATION_PREFIX = "wfrun:"

export function workflowRunCorrelationId(runId: string): string {
  return `${WORKFLOW_RUN_CORRELATION_PREFIX}${runId}`
}

export function parseWorkflowRunCorrelationId(correlationId?: string | null): string | null {
  if (typeof correlationId !== "string") return null
  if (!correlationId.startsWith(WORKFLOW_RUN_CORRELATION_PREFIX)) return null
  const runId = correlationId.slice(WORKFLOW_RUN_CORRELATION_PREFIX.length)
  return runId === "" ? null : runId
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createWorkflowAutomationService(deps: WorkflowAutomationServiceDeps) {
  const events = deps.events ?? getEventBus()
  const now = deps.now ?? (() => new Date())

  /* ------------------------------ authoring ------------------------------ */

  async function list(
    ctx: WorkflowAutomationServiceContext,
    rawQuery: unknown,
  ): Promise<WorkflowListResult> {
    requirePermission(workflowPermission(ctx, "read"))
    const query = workflowQuerySchema.parse(rawQuery)
    return deps.store.list(ctx.workspaceId, query)
  }

  async function get(ctx: WorkflowAutomationServiceContext, id: string): Promise<WorkflowRecord> {
    requirePermission(workflowPermission(ctx, "read"))
    const found = await deps.store.findById(ctx.workspaceId, id)
    if (!found) throw new WorkflowNotFoundError(id)
    return found
  }

  async function create(
    ctx: WorkflowAutomationServiceContext,
    rawInput: unknown,
  ): Promise<WorkflowRecord> {
    requirePermission(workflowPermission(ctx, "create"))
    const input = createWorkflowSchema.parse(rawInput)
    // A workflow runs as its owner, so letting an author hand ownership to
    // a more privileged colleague would be an escalation. Ownership is the
    // author unless an automation admin says otherwise.
    const ownerId =
      input.ownerId == null || input.ownerId === ctx.actorId
        ? ctx.actorId
        : assertMayAssignOwner(ctx, input.ownerId)
    const workflow = await deps.store.create(
      ctx.workspaceId,
      { ...input, ownerId, status: "disabled" },
      ctx.actorId,
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: WORKFLOW_OBJECT,
      recordId: workflow.id,
      after: workflow,
      correlationId: ctx.correlationId,
    })
    return workflow
  }

  function assertMayAssignOwner(ctx: WorkflowAutomationServiceContext, ownerId: string): string {
    requirePermission(workflowPermission(ctx, "admin"))
    return ownerId
  }

  async function update(
    ctx: WorkflowAutomationServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<WorkflowRecord> {
    requirePermission(workflowPermission(ctx, "update"))
    const patch = updateWorkflowSchema.parse(rawPatch)
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new WorkflowNotFoundError(id)
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
    if (!after) throw new WorkflowNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: WORKFLOW_OBJECT,
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /**
   * Enable / disable. Turning an automation ON is the privileged act (it
   * is what makes it start writing to the workspace), so it needs
   * `run_automation` — "automation admin" in spec 25 §8. Turning one OFF
   * only needs `update`: stopping a runaway workflow must never be harder
   * than starting it.
   */
  async function setEnabled(
    ctx: WorkflowAutomationServiceContext,
    id: string,
    enabled: boolean,
  ): Promise<WorkflowRecord> {
    requirePermission(workflowPermission(ctx, enabled ? "run_automation" : "update"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new WorkflowNotFoundError(id)
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      { status: enabled ? "enabled" : "disabled" },
      ctx.actorId,
    )
    if (!after) throw new WorkflowNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: enabled ? "enable" : "disable",
      object: WORKFLOW_OBJECT,
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function softDelete(
    ctx: WorkflowAutomationServiceContext,
    id: string,
  ): Promise<WorkflowRecord> {
    requirePermission(workflowPermission(ctx, "delete"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new WorkflowNotFoundError(id)
    await deps.store.softDelete(ctx.workspaceId, id, ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: WORKFLOW_OBJECT,
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function restore(
    ctx: WorkflowAutomationServiceContext,
    id: string,
  ): Promise<WorkflowRecord> {
    requirePermission(workflowPermission(ctx, "update"))
    await deps.store.restore(ctx.workspaceId, id)
    const after = await deps.store.findById(ctx.workspaceId, id)
    if (!after) throw new WorkflowNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "restore",
      object: WORKFLOW_OBJECT,
      recordId: id,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /* ------------------------------ run history ----------------------------- */

  async function listRuns(
    ctx: WorkflowAutomationServiceContext,
    rawQuery: unknown,
  ): Promise<WorkflowRunListResult> {
    requirePermission(workflowPermission(ctx, "read"))
    const query = workflowRunQuerySchema.parse(rawQuery)
    return deps.store.listRuns(ctx.workspaceId, query)
  }

  async function getRun(
    ctx: WorkflowAutomationServiceContext,
    runId: string,
  ): Promise<WorkflowRunWithSteps> {
    requirePermission(workflowPermission(ctx, "read"))
    const run = await deps.store.findRunById(ctx.workspaceId, runId)
    if (!run) throw new WorkflowRunNotFoundError(runId)
    const steps = await deps.store.listRunSteps(ctx.workspaceId, runId)
    return { run, steps }
  }

  /* ------------------------------- dispatch ------------------------------- */

  /**
   * Entry point from the event bus. Finds the enabled workflows listening
   * to this event, records one run per match and queues the runnable ones.
   *
   * Not a user-callable method: it carries no caller context because there
   * is no caller — the *event's* actor caused it, and the run executes as
   * the workflow's owner, whose permissions are checked in `executeRun`.
   * Nothing here writes to a business record.
   */
  async function dispatch(event: WorkflowTriggerEnvelope): Promise<WorkflowDispatchResult> {
    const { depth, parentRunId } = await resolveCascade(event)
    const candidates = await deps.store.listEnabledByTrigger(event.workspaceId, event.event)
    const matched = candidates.filter((workflow) => matchesWorkflowTrigger(workflow, event))
    const decisions: WorkflowDispatchDecision[] = []

    for (const workflow of matched) {
      // LOOP PROTECTION: past the ceiling the run is recorded (so the user
      // can see why the cascade stopped) but never enqueued, so it emits
      // nothing and the chain terminates.
      const tooDeep = depth > WORKFLOW_MAX_CASCADE_DEPTH
      const { run, created } = await deps.store.createRun(event.workspaceId, {
        workflowId: workflow.id,
        triggerEventId: event.eventId,
        triggerEvent: event.event,
        entityType: event.entityType ?? null,
        entityId: event.entityId ?? null,
        triggerPayload: event,
        status: tooDeep ? "skipped" : "queued",
        depth,
        parentRunId,
        actorId: stringOrNull(workflow.ownerId) ?? stringOrNull(workflow.createdBy),
        correlationId: event.correlationId ?? null,
        error: tooDeep
          ? `cascade depth ${depth} exceeds the maximum of ${WORKFLOW_MAX_CASCADE_DEPTH}`
          : null,
      })

      // IDEMPOTENCY: this exact event already produced this run. Do not
      // enqueue a second time — the actions have been (or are being) run.
      if (!created) {
        decisions.push({ workflowId: workflow.id, runId: run.id, outcome: "duplicate" })
        continue
      }
      if (tooDeep) {
        decisions.push({ workflowId: workflow.id, runId: run.id, outcome: "cascade_depth" })
        await emitRunEvent(AutomationEvents.Completed, run, { status: "skipped", depth })
        continue
      }

      try {
        await deps.queue.enqueueWorkflowRun({
          workspaceId: event.workspaceId,
          workflowId: workflow.id,
          runId: run.id,
          triggerEventId: event.eventId,
          depth,
          maxDepth: WORKFLOW_MAX_CASCADE_DEPTH,
          ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
        })
      } catch (err) {
        // The run row already exists and, being keyed on the event id, a
        // redelivery would be treated as a duplicate and never enqueued.
        // So a failed enqueue has to be visible rather than silent.
        await finishRun(run, "failed", 0, `could not queue the run: ${errorMessage(err)}`)
        decisions.push({ workflowId: workflow.id, runId: run.id, outcome: "queue_failed" })
        continue
      }
      decisions.push({ workflowId: workflow.id, runId: run.id, outcome: "queued" })
    }

    return {
      event: event.event,
      eventId: event.eventId,
      depth,
      matched: matched.length,
      decisions,
    }
  }

  /** Depth of the run this event would create, from the run that caused it. */
  async function resolveCascade(
    event: WorkflowTriggerEnvelope,
  ): Promise<{ depth: number; parentRunId: string | null }> {
    const parentRunId = parseWorkflowRunCorrelationId(event.correlationId)
    if (parentRunId === null) return { depth: 0, parentRunId: null }
    const parent = await deps.store.findRunById(event.workspaceId, parentRunId)
    if (!parent) return { depth: 1, parentRunId: null }
    return { depth: (parent.depth ?? 0) + 1, parentRunId: parent.id }
  }

  /**
   * Manual test run (spec 25 §3). Builds a synthetic envelope from the
   * workflow's own trigger and dispatches it, so a test run is the
   * production path — same conditions, same permissions, same queue.
   */
  async function runNow(
    ctx: WorkflowAutomationServiceContext,
    id: string,
    rawInput: unknown,
  ): Promise<WorkflowDispatchResult> {
    requirePermission(workflowPermission(ctx, "run_automation"))
    const input = runWorkflowSchema.parse(rawInput)
    const workflow = await deps.store.findById(ctx.workspaceId, id)
    if (!workflow) throw new WorkflowNotFoundError(id)
    const entityType = input.entityType ?? stringOrNull(workflow.triggerEntityType) ?? undefined
    const envelope = createEvent({
      event: String(workflow.triggerEvent ?? ""),
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      ...(entityType === undefined ? {} : { entityType }),
      ...(input.entityId === undefined ? {} : { entityId: input.entityId }),
      after: input.sample ?? {},
      ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
    })
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "run",
      object: WORKFLOW_OBJECT,
      recordId: id,
      after: { triggerEventId: envelope.eventId, manual: true },
      correlationId: ctx.correlationId,
    })
    return dispatch(envelope)
  }

  /* ------------------------------- execution ------------------------------ */

  /**
   * Execute one queued run. Called by the worker job through the queue
   * seam, never from a request handler.
   *
   * No caller context: the run already names the actor it inherits from,
   * and taking one would be the escalation hole this design exists to
   * close.
   */
  async function executeRun(workspaceId: string, runId: string): Promise<WorkflowRunOutcome> {
    const run = await deps.store.findRunById(workspaceId, runId)
    if (!run) throw new WorkflowRunNotFoundError(runId)

    // IDEMPOTENCY: the job was redelivered after the run already finished.
    if (run.status === "succeeded" || run.status === "failed" || run.status === "skipped") {
      return { runId, status: run.status, executedSteps: 0 }
    }

    const workflow = await deps.store.findById(workspaceId, run.workflowId)
    if (!workflow) {
      return finishRun(run, "failed", 0, `workflow ${run.workflowId} no longer exists`)
    }
    // LOOP PROTECTION, second line: a payload that claims a legal depth
    // cannot outrun the record.
    if ((run.depth ?? 0) > WORKFLOW_MAX_CASCADE_DEPTH) {
      return finishRun(
        run,
        "skipped",
        0,
        `cascade depth ${run.depth} exceeds the maximum of ${WORKFLOW_MAX_CASCADE_DEPTH}`,
      )
    }

    // PERMISSION INHERITANCE: resolve the owner's role NOW, not when the
    // workflow was written, and refuse to run at all if they have left.
    const ownerId = stringOrNull(workflow.ownerId) ?? stringOrNull(workflow.createdBy) ?? ""
    let actorRole: string
    try {
      const resolved = ownerId === "" ? null : await deps.resolveActorRole(workspaceId, ownerId)
      assertWorkflowActorResolved(workspaceId, ownerId, resolved)
      actorRole = resolved
      requirePermission({
        workspaceId,
        actorId: ownerId,
        role: actorRole,
        object: WORKFLOW_OBJECT,
        action: "read",
      })
    } catch (err) {
      return finishRun(run, "failed", 0, errorMessage(err))
    }

    const actorCtx = {
      workspaceId,
      actorId: ownerId,
      role: actorRole,
      correlationId: workflowRunCorrelationId(run.id),
    }
    const startedRun =
      (await deps.store.updateRun(workspaceId, run.id, {
        status: "running",
        startedAt: now(),
        actorRole,
      })) ?? run
    await emitRunEvent(AutomationEvents.RunStarted, startedRun, {
      workflowId: workflow.id,
      depth: run.depth ?? 0,
      actorId: ownerId,
    })

    const envelope = triggerEnvelopeOf(run)
    if (!matchesWorkflowConditions(workflow.conditions, envelope)) {
      return finishRun(startedRun, "skipped", 0, "conditions did not match")
    }

    const record = toWorkflowConditionRecord(envelope)
    const target = targetOf(run)
    let actions: WorkflowActionInput[]
    try {
      actions = parseActions(workflow)
    } catch (err) {
      // A definition the engine cannot read fails loudly as a run, rather
      // than crashing the job and retrying four more times.
      return finishRun(startedRun, "failed", 0, errorMessage(err))
    }
    let executedSteps = 0

    for (const [index, action] of actions.entries()) {
      // IDEMPOTENCY, per step: a retried job re-claims each slot and skips
      // whatever a previous attempt already owned.
      const { step, claimed } = await deps.store.claimRunStep(workspaceId, {
        runId: run.id,
        stepIndex: index,
        actionType: action.type,
      })
      if (!claimed) continue

      try {
        assertWorkflowActionAllowed(actorCtx, action.type, target)
        const result = await performAction(actorCtx, action, target, record)
        await deps.store.completeRunStep(workspaceId, step.id, {
          status: "succeeded",
          result,
        })
        executedSteps += 1
      } catch (err) {
        const message = errorMessage(err)
        await deps.store.completeRunStep(workspaceId, step.id, {
          status: "failed",
          error: message,
        })
        await emitRunEvent(AutomationEvents.StepFailed, startedRun, {
          workflowId: workflow.id,
          stepIndex: index,
          actionType: action.type,
          error: message,
          forbidden: err instanceof PermissionDeniedError,
        })
        return finishRun(startedRun, "failed", executedSteps, message)
      }
    }

    await deps.store.markWorkflowRan(workspaceId, workflow.id)
    return finishRun(startedRun, "succeeded", executedSteps)
  }

  function triggerEnvelopeOf(run: WorkflowRunRecord): WorkflowTriggerEnvelope {
    const payload = run.triggerPayload
    if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
      return payload as WorkflowTriggerEnvelope
    }
    return {
      eventId: String(run.triggerEventId ?? ""),
      event: String(run.triggerEvent ?? ""),
      workspaceId: run.workspaceId,
      ...(stringOrNull(run.entityType) === null ? {} : { entityType: String(run.entityType) }),
      ...(stringOrNull(run.entityId) === null ? {} : { entityId: String(run.entityId) }),
    }
  }

  function targetOf(run: WorkflowRunRecord): WorkflowActionTarget | null {
    const entityType = stringOrNull(run.entityType)
    const entityId = stringOrNull(run.entityId)
    return entityType === null || entityId === null ? null : { entityType, entityId }
  }

  /**
   * Re-validate the stored actions before executing them. A definition
   * saved by an older version — or edited around the API — never reaches
   * the executor unvalidated.
   */
  function parseActions(workflow: WorkflowRecord): WorkflowActionInput[] {
    const raw = workflow.actions
    if (!Array.isArray(raw)) throw new WorkflowActionError("workflow has no action list")
    return raw.map((action) => workflowActionSchema.parse(action))
  }

  async function performAction(
    actorCtx: WorkflowAutomationServiceContext,
    action: WorkflowActionInput,
    target: WorkflowActionTarget | null,
    record: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (action.type) {
      case "create_task": {
        const created = await deps.executor.createTask(actorCtx, {
          title: renderWorkflowTemplate(action.title, record),
          description:
            action.description == null ? null : renderWorkflowTemplate(action.description, record),
          priority: action.priority ?? null,
          dueDate: action.dueInDays == null ? null : dueDateIn(action.dueInDays),
          assigneeId: action.assigneeId ?? actorCtx.actorId,
          target,
        })
        return { taskId: created.taskId }
      }
      case "update_field": {
        if (target === null) {
          throw new WorkflowActionError("update_field needs a triggering record")
        }
        const updated = await deps.executor.updateRecordField(
          actorCtx,
          target,
          action.field,
          typeof action.value === "string"
            ? renderWorkflowTemplate(action.value, record)
            : action.value,
        )
        return { recordId: updated.recordId, field: action.field }
      }
      case "add_tag": {
        if (target === null) throw new WorkflowActionError("add_tag needs a triggering record")
        const tagged = await deps.executor.addTag(actorCtx, target, action.tag)
        return { tagId: tagged.tagId, tag: action.tag }
      }
      case "notify": {
        const notified = await deps.executor.notify(actorCtx, {
          userId: action.userId ?? actorCtx.actorId,
          type: "automation",
          title: renderWorkflowTemplate(action.title, record),
          body: action.body == null ? null : renderWorkflowTemplate(action.body, record),
        })
        return { notificationId: notified.notificationId }
      }
    }
  }

  function dueDateIn(days: number): string {
    const due = new Date(now().getTime() + days * 24 * 60 * 60 * 1000)
    return due.toISOString()
  }

  async function finishRun(
    run: WorkflowRunRecord,
    status: "succeeded" | "failed" | "skipped",
    executedSteps: number,
    error?: string,
  ): Promise<WorkflowRunOutcome> {
    const finished =
      (await deps.store.updateRun(run.workspaceId, run.id, {
        status,
        finishedAt: now(),
        error: error ?? null,
      })) ?? run
    await emitRunEvent(AutomationEvents.Completed, finished, {
      status,
      executedSteps,
      ...(error === undefined ? {} : { error }),
    })
    await deps.audit({
      workspaceId: run.workspaceId,
      actorId: stringOrNull(run.actorId),
      action: "run",
      object: WORKFLOW_OBJECT,
      recordId: String(run.workflowId),
      after: { runId: run.id, status, executedSteps, ...(error === undefined ? {} : { error }) },
      correlationId: workflowRunCorrelationId(run.id),
      source: "automation",
    })
    return { runId: run.id, status, executedSteps, ...(error === undefined ? {} : { error }) }
  }

  /**
   * Engine telemetry. `actorType: "automation"` and the `wfrun:`
   * correlation id mark these as machine-made; they are also not in
   * `WORKFLOW_TRIGGER_EVENTS`, so emitting them can never start a cascade.
   */
  async function emitRunEvent(
    name: string,
    run: WorkflowRunRecord,
    after: Record<string, unknown>,
  ): Promise<void> {
    await events.emit(
      createEvent({
        event: name,
        workspaceId: run.workspaceId,
        actorType: "automation",
        entityType: "workflow_run",
        entityId: run.id,
        after: { workflowId: run.workflowId, ...after },
        correlationId: workflowRunCorrelationId(run.id),
        ...(stringOrNull(run.actorId) === null ? {} : { actorId: String(run.actorId) }),
      }),
    )
  }

  return {
    list,
    get,
    create,
    update,
    setEnabled,
    softDelete,
    restore,
    listRuns,
    getRun,
    dispatch,
    runNow,
    executeRun,
  }
}

export type WorkflowAutomationService = ReturnType<typeof createWorkflowAutomationService>

/**
 * Subscribe the dispatcher to the in-process event bus.
 *
 * WIRING NOTE: the application bootstrap (`apps/api/src/index.ts`) owns
 * this call — route factories must not subscribe, because route
 * construction happens in tests that emit unrelated events on the shared
 * bus. `apps/api/src/routes/modules/automation.ts` re-exports a bound
 * version (`subscribeAutomationDispatcher`) so the bootstrap is one line.
 *
 * Returns the unsubscribe function.
 */
export function subscribeWorkflowDispatcher(
  bus: {
    on(event: string, handler: (event: WorkflowTriggerEnvelope) => Promise<void>): () => void
  },
  service: Pick<WorkflowAutomationService, "dispatch">,
  onError: (err: unknown, event: WorkflowTriggerEnvelope) => void = () => {},
): () => void {
  return bus.on("*", async (event: WorkflowTriggerEnvelope) => {
    // A failing automation must never fail the business write that
    // triggered it: the run row already records what happened.
    try {
      await service.dispatch(event)
    } catch (err) {
      onError(err, event)
    }
  })
}
