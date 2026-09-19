import { beforeEach, describe, expect, test } from "bun:test"
import { AutomationEvents, createEvent, CrmEvents, EventBus } from "@yourcrm/events"
import type { DomainEvent } from "@yourcrm/events"
import { PermissionDeniedError } from "@yourcrm/permissions"
import {
  createStore,
  expectDenied,
  makeBaseRecord,
  makeServiceContext,
  nextId,
} from "@yourcrm/testing"
import type { BaseRecord, ServiceContext } from "@yourcrm/validation"
import { WORKFLOW_MAX_CASCADE_DEPTH } from "./schemas"
import {
  createWorkflowAutomationService,
  subscribeWorkflowDispatcher,
  workflowRunCorrelationId,
} from "./service"
import type {
  WorkflowActionExecutorPort,
  WorkflowActionTarget,
  WorkflowAuditInput,
  WorkflowAutomationStore,
  WorkflowRecord,
  WorkflowRunJobRequest,
  WorkflowRunListQuery,
  WorkflowRunRecord,
  WorkflowRunStepRecord,
} from "./types"

/**
 * Hermetic engine tests. No Postgres, no Redis: the store fake reproduces
 * the two UNIQUE indexes from migration 0190 (one run per
 * (workflow, trigger event), one step per (run, index)), and the queue
 * fake records enqueues and can drive the run inline so a whole
 * event -> run -> action chain is observable in one test.
 *
 * The three properties the module exists for each get a named test:
 *   automation/idempotency        — redelivery performs the action once
 *   automation/permission-inheritance — a viewer's workflow cannot write
 *   automation/loop-protection    — a self-triggering workflow terminates
 */

const WS = "ws_auto_1"

type StoredWorkflow = BaseRecord & {
  name: string
  description: string | null
  triggerEvent: string
  triggerEntityType: string | null
  conditions: unknown
  actions: unknown
  status: string
  ownerId: string | null
  lastRunAt: string | null
}

function asWorkflow(row: StoredWorkflow): WorkflowRecord {
  return row as unknown as WorkflowRecord
}

/** Store fake with the migration's uniqueness guarantees, nothing more. */
function createFakeAutomationStore() {
  const workflows = createStore<StoredWorkflow>()
  const runs = new Map<string, WorkflowRunRecord>()
  const runByEvent = new Map<string, string>()
  const steps = new Map<string, WorkflowRunStepRecord>()
  const stepByIndex = new Map<string, string>()

  const store: WorkflowAutomationStore = {
    list: async (workspaceId, query) => {
      let rows = workflows.list(workspaceId)
      if (query.status) rows = rows.filter((r) => r.status === query.status)
      if (query.triggerEvent) rows = rows.filter((r) => r.triggerEvent === query.triggerEvent)
      if (query.query) {
        const needle = query.query.toLowerCase()
        rows = rows.filter((r) => r.name.toLowerCase().includes(needle))
      }
      const limit = query.limit ?? 25
      return {
        data: rows.slice(0, limit).map(asWorkflow),
        pagination: { nextCursor: null, limit },
      }
    },
    findById: async (workspaceId, id) => {
      const row = workflows.get(id, workspaceId)
      return row ? asWorkflow(row) : null
    },
    create: async (workspaceId, input, actorId) =>
      asWorkflow(
        workflows.insert({
          ...makeBaseRecord({ workspaceId }),
          name: String(input.name ?? ""),
          description: (input.description as string | null) ?? null,
          triggerEvent: String(input.triggerEvent ?? ""),
          triggerEntityType: (input.triggerEntityType as string | null) ?? null,
          conditions: input.conditions ?? null,
          actions: input.actions ?? [],
          status: (input.status as string | null) ?? "disabled",
          ownerId: (input.ownerId as string | null) ?? actorId ?? null,
          lastRunAt: null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      ),
    update: async (workspaceId, id, input) => {
      const row = workflows.update(id, workspaceId, input as Partial<StoredWorkflow>)
      return row ? asWorkflow(row) : null
    },
    softDelete: async (workspaceId, id) => {
      workflows.remove(id, workspaceId)
    },
    restore: async (workspaceId, id) => {
      workflows.restore(id, workspaceId)
    },
    listEnabledByTrigger: async (workspaceId, triggerEvent) =>
      workflows
        .list(workspaceId)
        .filter((r) => r.status === "enabled" && r.triggerEvent === triggerEvent)
        .map(asWorkflow),
    markWorkflowRan: async (workspaceId, id) => {
      workflows.update(id, workspaceId, { lastRunAt: new Date().toISOString() })
    },
    // Mirrors UNIQUE (workflow_id, trigger_event_id) + ON CONFLICT DO NOTHING.
    createRun: async (workspaceId, input) => {
      const key = `${String(input.workflowId)}:${String(input.triggerEventId)}`
      const existingId = runByEvent.get(key)
      if (existingId) {
        const existing = runs.get(existingId)
        if (existing) return { run: existing, created: false }
      }
      const run: WorkflowRunRecord = {
        ...(input as Record<string, unknown>),
        id: nextId("run"),
        workspaceId,
        workflowId: String(input.workflowId),
        status: String(input.status ?? "queued"),
        depth: Number(input.depth ?? 0),
      }
      runs.set(run.id, run)
      runByEvent.set(key, run.id)
      return { run, created: true }
    },
    findRunById: async (workspaceId, id) => {
      const run = runs.get(id)
      return run && run.workspaceId === workspaceId ? run : null
    },
    listRuns: async (workspaceId: string, query: WorkflowRunListQuery) => {
      let rows = [...runs.values()].filter((r) => r.workspaceId === workspaceId)
      if (query.workflowId) rows = rows.filter((r) => r.workflowId === query.workflowId)
      if (query.status) rows = rows.filter((r) => r.status === query.status)
      const limit = query.limit ?? 25
      return { data: rows.slice(0, limit), pagination: { nextCursor: null, limit } }
    },
    updateRun: async (workspaceId, id, patch) => {
      const run = runs.get(id)
      if (!run || run.workspaceId !== workspaceId) return null
      const next = { ...run, ...patch, status: String(patch.status ?? run.status) }
      runs.set(id, next)
      return next
    },
    // Mirrors UNIQUE (run_id, step_index) + ON CONFLICT DO NOTHING.
    claimRunStep: async (workspaceId, input) => {
      const key = `${input.runId}:${input.stepIndex}`
      const existingId = stepByIndex.get(key)
      if (existingId) {
        const existing = steps.get(existingId)
        if (existing) return { step: existing, claimed: false }
      }
      const step: WorkflowRunStepRecord = {
        id: nextId("step"),
        workspaceId,
        runId: input.runId,
        stepIndex: input.stepIndex,
        actionType: input.actionType,
        status: "running",
      }
      steps.set(step.id, step)
      stepByIndex.set(key, step.id)
      return { step, claimed: true }
    },
    completeRunStep: async (_workspaceId, id, patch) => {
      const step = steps.get(id)
      if (!step) return null
      const next = { ...step, ...patch, status: String(patch.status ?? step.status) }
      steps.set(id, next)
      return next
    },
    listRunSteps: async (_workspaceId, runId) =>
      [...steps.values()]
        .filter((s) => s.runId === runId)
        .sort((a, b) => a.stepIndex - b.stepIndex),
  }

  return { store, workflows, runs, steps }
}

type ExecutorCalls = {
  createTask: { ctx: ServiceContext; title: string }[]
  updateRecordField: { ctx: ServiceContext; target: WorkflowActionTarget; field: string }[]
  addTag: { target: WorkflowActionTarget; tag: string }[]
  notify: { userId: string; title: string }[]
}

function createFakeExecutor(
  onUpdateField?: (ctx: ServiceContext, target: WorkflowActionTarget) => Promise<void>,
) {
  const calls: ExecutorCalls = { createTask: [], updateRecordField: [], addTag: [], notify: [] }
  const executor: WorkflowActionExecutorPort = {
    createTask: async (ctx, input) => {
      calls.createTask.push({ ctx, title: input.title })
      return { taskId: nextId("task") }
    },
    updateRecordField: async (ctx, target, field) => {
      calls.updateRecordField.push({ ctx, target, field })
      if (onUpdateField) await onUpdateField(ctx, target)
      return { recordId: target.entityId }
    },
    addTag: async (_ctx, target, tag) => {
      calls.addTag.push({ target, tag })
      return { tagId: nextId("tag") }
    },
    notify: async (_ctx, input) => {
      calls.notify.push({ userId: input.userId, title: input.title })
      return { notificationId: nextId("notif") }
    },
  }
  return { executor, calls }
}

/** Queue double: records enqueues and can drive the run inline. */
function createFakeQueue(run?: (request: WorkflowRunJobRequest) => Promise<void>) {
  const enqueued: WorkflowRunJobRequest[] = []
  return {
    enqueued,
    queue: {
      enqueueWorkflowRun: async (request: WorkflowRunJobRequest) => {
        enqueued.push(request)
        if (run) await run(request)
      },
    },
  }
}

type Harness = ReturnType<typeof makeHarness>

function makeHarness(
  options: {
    roles?: Record<string, string>
    driveInline?: boolean
    onUpdateField?: (ctx: ServiceContext, target: WorkflowActionTarget) => Promise<void>
  } = {},
) {
  const fake = createFakeAutomationStore()
  const { executor, calls } = createFakeExecutor(options.onUpdateField)
  const audits: WorkflowAuditInput[] = []
  const emitted: { event: string; after?: unknown }[] = []
  const roles = options.roles ?? {}

  // The inline queue calls back into the service that owns it, so the
  // executor is bound after construction rather than captured before it.
  let executeRun = async (_workspaceId: string, _runId: string): Promise<unknown> => {
    throw new Error("queue drained before the service was built")
  }
  const { enqueued, queue } = createFakeQueue(
    options.driveInline
      ? async (request) => {
          await executeRun(request.workspaceId, request.runId)
        }
      : undefined,
  )

  const service = createWorkflowAutomationService({
    store: fake.store,
    audit: async (input) => {
      audits.push(input)
    },
    events: {
      emit: async (event) => {
        emitted.push({ event: event.event, after: event.after })
      },
    },
    queue,
    executor,
    resolveActorRole: async (_workspaceId, actorId) => roles[actorId] ?? null,
  })
  executeRun = service.executeRun

  return { ...fake, service, calls, audits, emitted, enqueued, roles }
}

function seedWorkflow(h: Harness, overrides: Partial<StoredWorkflow> = {}): WorkflowRecord {
  return asWorkflow(
    h.workflows.insert({
      ...makeBaseRecord({ workspaceId: WS }),
      name: "Welcome flow",
      description: null,
      triggerEvent: CrmEvents.PersonCreated,
      triggerEntityType: null,
      conditions: null,
      actions: [{ type: "create_task", title: "Call {{firstName}}" }],
      status: "enabled",
      ownerId: "owner_admin",
      lastRunAt: null,
      ...overrides,
    }),
  )
}

function personCreated(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    ...createEvent({
      event: CrmEvents.PersonCreated,
      workspaceId: WS,
      actorId: "user_1",
      entityType: "person",
      entityId: "person_1",
      after: { firstName: "Ada", status: "active" },
    }),
    ...overrides,
  }
}

const ADMIN_ROLES = { owner_admin: "admin", viewer_owner: "viewer", member_owner: "member" }

/* ------------------------------- authoring ------------------------------- */

describe("automation/authoring", () => {
  let h: Harness

  beforeEach(() => {
    h = makeHarness({ roles: ADMIN_ROLES })
  })

  test("a workflow is created disabled and audited", async () => {
    const ctx = makeServiceContext({ workspaceId: WS, actorId: "author_1", role: "member" })
    const workflow = await h.service.create(ctx, {
      name: "Welcome flow",
      triggerEvent: CrmEvents.PersonCreated,
      actions: [{ type: "create_task", title: "Call {{firstName}}" }],
    })
    expect(workflow.status).toBe("disabled")
    expect(workflow.ownerId).toBe("author_1")
    expect(h.audits.at(-1)?.action).toBe("create")
  })

  test("an unknown trigger event is rejected (constants, never literals)", async () => {
    const ctx = makeServiceContext({ workspaceId: WS, actorId: "author_1", role: "member" })
    await expect(
      h.service.create(ctx, {
        name: "Nope",
        triggerEvent: "person.exploded",
        actions: [{ type: "create_task", title: "x" }],
      }),
    ).rejects.toThrow()
  })

  test("engine events are not triggerable, so a workflow cannot listen to itself", async () => {
    const ctx = makeServiceContext({ workspaceId: WS, actorId: "author_1", role: "member" })
    await expect(
      h.service.create(ctx, {
        name: "Recursive",
        triggerEvent: AutomationEvents.Completed,
        actions: [{ type: "create_task", title: "x" }],
      }),
    ).rejects.toThrow()
  })

  test("a viewer cannot author a workflow", async () => {
    const ctx = makeServiceContext({ workspaceId: WS, actorId: "viewer_1", role: "viewer" })
    await expectDenied(() =>
      h.service.create(ctx, {
        name: "Welcome flow",
        triggerEvent: CrmEvents.PersonCreated,
        actions: [{ type: "create_task", title: "x" }],
      }),
    )
  })

  test("enabling needs automation admin; disabling only needs update", async () => {
    const workflow = seedWorkflow(h, { status: "disabled" })
    const member = makeServiceContext({ workspaceId: WS, actorId: "member_1", role: "member" })
    await expectDenied(() => h.service.setEnabled(member, workflow.id, true))

    const admin = makeServiceContext({ workspaceId: WS, actorId: "admin_1", role: "admin" })
    const enabled = await h.service.setEnabled(admin, workflow.id, true)
    expect(enabled.status).toBe("enabled")

    // Stopping a runaway automation must never be harder than starting it.
    const disabled = await h.service.setEnabled(member, workflow.id, false)
    expect(disabled.status).toBe("disabled")
  })

  test("assigning the workflow to somebody else needs admin (it runs as them)", async () => {
    const member = makeServiceContext({ workspaceId: WS, actorId: "member_1", role: "member" })
    await expectDenied(() =>
      h.service.create(member, {
        name: "Sneaky",
        triggerEvent: CrmEvents.PersonCreated,
        ownerId: "owner_admin",
        actions: [{ type: "create_task", title: "x" }],
      }),
    )
  })

  test("an unauthenticated caller cannot list workflows or runs", async () => {
    const stranger = makeServiceContext({ workspaceId: WS, actorId: "", role: "viewer" })
    await expectDenied(() => h.service.list(stranger, {}))
    await expectDenied(() => h.service.listRuns(stranger, {}))
  })

  test("disabled workflows never reach the engine", async () => {
    seedWorkflow(h, { status: "disabled" })
    const result = await h.service.dispatch(personCreated())
    expect(result.matched).toBe(0)
    expect(h.enqueued).toHaveLength(0)
  })
})

/* ------------------------------ dispatch/run ------------------------------ */

describe("automation/execution", () => {
  test("a matching event queues a run and the run performs the action", async () => {
    const h = makeHarness({ roles: ADMIN_ROLES, driveInline: true })
    seedWorkflow(h)
    const result = await h.service.dispatch(personCreated())

    expect(result.matched).toBe(1)
    expect(result.decisions[0]?.outcome).toBe("queued")
    expect(h.enqueued).toHaveLength(1)
    expect(h.calls.createTask).toHaveLength(1)
    // The template resolved against the triggering record.
    expect(h.calls.createTask[0]?.title).toBe("Call Ada")

    const run = h.runs.get(String(result.decisions[0]?.runId))
    expect(run?.status).toBe("succeeded")
    expect(h.emitted.map((e) => e.event)).toEqual([
      AutomationEvents.RunStarted,
      AutomationEvents.Completed,
    ])
  })

  test("conditions that do not match record a skipped run, not a failure", async () => {
    const h = makeHarness({ roles: ADMIN_ROLES, driveInline: true })
    seedWorkflow(h, {
      conditions: {
        type: "group",
        id: "g1",
        combinator: "and",
        children: [{ type: "condition", id: "c1", field: "status", operator: "eq", value: "vip" }],
      },
    })
    const result = await h.service.dispatch(personCreated())
    const run = h.runs.get(String(result.decisions[0]?.runId))
    expect(run?.status).toBe("skipped")
    expect(h.calls.createTask).toHaveLength(0)
  })

  test("a failing action fails the run, emits step_failed and stops later steps", async () => {
    const h = makeHarness({ roles: ADMIN_ROLES, driveInline: true })
    seedWorkflow(h, {
      actions: [
        // No triggering record is required for create_task, but update_field
        // needs one — this event carries none, so step 0 fails.
        { type: "update_field", field: "status", value: "hot" },
        { type: "create_task", title: "never runs" },
      ],
    })
    const result = await h.service.dispatch(
      personCreated({ entityType: undefined, entityId: undefined }),
    )
    const runId = String(result.decisions[0]?.runId)
    expect(h.runs.get(runId)?.status).toBe("failed")
    expect(h.calls.createTask).toHaveLength(0)
    expect(h.emitted.map((e) => e.event)).toContain(AutomationEvents.StepFailed)

    const steps = await h.store.listRunSteps(WS, runId)
    expect(steps).toHaveLength(1)
    expect(steps[0]?.status).toBe("failed")
  })

  test("actions run as the workflow owner, not as whoever caused the event", async () => {
    const h = makeHarness({ roles: ADMIN_ROLES, driveInline: true })
    seedWorkflow(h, { ownerId: "owner_admin" })
    await h.service.dispatch(personCreated({ actorId: "some_other_user" }))
    const ctx = h.calls.createTask[0]?.ctx
    expect(ctx?.actorId).toBe("owner_admin")
    expect(ctx?.role).toBe("admin")
  })

  test("a run whose owner left the workspace is refused, not downgraded", async () => {
    const h = makeHarness({ roles: {}, driveInline: true })
    seedWorkflow(h, { ownerId: "ghost" })
    const result = await h.service.dispatch(personCreated())
    const run = h.runs.get(String(result.decisions[0]?.runId))
    expect(run?.status).toBe("failed")
    expect(String(run?.error)).toContain("no longer a member")
    expect(h.calls.createTask).toHaveLength(0)
  })

  test("a manual test run takes the production path", async () => {
    const h = makeHarness({ roles: ADMIN_ROLES, driveInline: true })
    const workflow = seedWorkflow(h)
    const admin = makeServiceContext({ workspaceId: WS, actorId: "admin_1", role: "admin" })
    const result = await h.service.runNow(admin, workflow.id, {
      entityType: "person",
      entityId: "person_9",
      sample: { firstName: "Grace" },
    })
    expect(result.decisions[0]?.outcome).toBe("queued")
    expect(h.calls.createTask[0]?.title).toBe("Call Grace")
  })

  test("a member cannot fire a manual run (automation admin only)", async () => {
    const h = makeHarness({ roles: ADMIN_ROLES })
    const workflow = seedWorkflow(h)
    const member = makeServiceContext({ workspaceId: WS, actorId: "member_1", role: "member" })
    await expectDenied(() => h.service.runNow(member, workflow.id, {}))
  })

  test("a failed enqueue marks the run failed instead of losing it silently", async () => {
    // The run row is keyed on the event id, so a redelivery would be a
    // duplicate and never re-queued — a swallowed enqueue error would mean
    // the automation never runs and nobody ever finds out.
    const h = makeHarness({ roles: ADMIN_ROLES })
    const broken = createWorkflowAutomationService({
      store: h.store,
      audit: async () => {},
      events: { emit: async () => {} },
      queue: {
        enqueueWorkflowRun: async () => {
          throw new Error("redis is down")
        },
      },
      executor: createFakeExecutor().executor,
      resolveActorRole: async () => "admin",
    })
    seedWorkflow(h)
    const result = await broken.dispatch(personCreated())
    expect(result.decisions[0]?.outcome).toBe("queue_failed")
    const run = h.runs.get(String(result.decisions[0]?.runId))
    expect(run?.status).toBe("failed")
    expect(String(run?.error)).toContain("redis is down")
  })

  test("run history exposes per-step results", async () => {
    const h = makeHarness({ roles: ADMIN_ROLES, driveInline: true })
    seedWorkflow(h, {
      actions: [
        { type: "create_task", title: "Call {{firstName}}" },
        { type: "notify", title: "New person {{firstName}}" },
      ],
    })
    const result = await h.service.dispatch(personCreated())
    const admin = makeServiceContext({ workspaceId: WS, actorId: "admin_1", role: "admin" })
    const detail = await h.service.getRun(admin, String(result.decisions[0]?.runId))
    expect(detail.run.status).toBe("succeeded")
    expect(detail.steps.map((s) => s.actionType)).toEqual(["create_task", "notify"])
    expect(detail.steps.every((s) => s.status === "succeeded")).toBe(true)
    // notify defaults to the workflow owner.
    expect(h.calls.notify[0]?.userId).toBe("owner_admin")
  })
})

/* ------------------------------ idempotency ------------------------------- */

describe("automation/idempotency", () => {
  test("processing the same event twice performs the action ONCE", async () => {
    const h = makeHarness({ roles: ADMIN_ROLES, driveInline: true })
    seedWorkflow(h)
    const event = personCreated()

    const first = await h.service.dispatch(event)
    const second = await h.service.dispatch(event)

    expect(first.decisions[0]?.outcome).toBe("queued")
    // Redelivery is recognised by (workflow, trigger event id) and never
    // reaches the queue, so the action cannot be applied twice.
    expect(second.decisions[0]?.outcome).toBe("duplicate")
    expect(second.decisions[0]?.runId).toBe(String(first.decisions[0]?.runId))
    expect(h.enqueued).toHaveLength(1)
    expect(h.calls.createTask).toHaveLength(1)
    expect(h.runs.size).toBe(1)
  })

  test("re-executing a finished run is a no-op", async () => {
    const h = makeHarness({ roles: ADMIN_ROLES, driveInline: true })
    seedWorkflow(h)
    const result = await h.service.dispatch(personCreated())
    const runId = String(result.decisions[0]?.runId)

    const again = await h.service.executeRun(WS, runId)
    expect(again.status).toBe("succeeded")
    expect(again.executedSteps).toBe(0)
    expect(h.calls.createTask).toHaveLength(1)
  })

  test("a retried job resumes instead of re-applying claimed steps", async () => {
    const h = makeHarness({ roles: ADMIN_ROLES })
    seedWorkflow(h, {
      actions: [
        { type: "create_task", title: "Call {{firstName}}" },
        { type: "notify", title: "Notify" },
      ],
    })
    const result = await h.service.dispatch(personCreated())
    const runId = String(result.decisions[0]?.runId)

    // Pretend a first attempt already claimed step 0 and died mid-flight.
    await h.store.claimRunStep(WS, { runId, stepIndex: 0, actionType: "create_task" })

    const outcome = await h.service.executeRun(WS, runId)
    expect(outcome.status).toBe("succeeded")
    expect(outcome.executedSteps).toBe(1)
    expect(h.calls.createTask).toHaveLength(0)
    expect(h.calls.notify).toHaveLength(1)
  })

  test("two different events on the same workflow each get their own run", async () => {
    const h = makeHarness({ roles: ADMIN_ROLES, driveInline: true })
    seedWorkflow(h)
    await h.service.dispatch(personCreated())
    await h.service.dispatch(personCreated())
    expect(h.calls.createTask).toHaveLength(2)
    expect(h.runs.size).toBe(2)
  })
})

/* ------------------------- permission inheritance ------------------------- */

describe("automation/permission-inheritance", () => {
  test("a workflow owned by a VIEWER cannot do what that viewer cannot do by hand", async () => {
    const h = makeHarness({ roles: ADMIN_ROLES, driveInline: true })
    // The owner authored this while a member and has since been demoted;
    // the definition is unchanged and still enabled.
    seedWorkflow(h, { ownerId: "viewer_owner" })

    const result = await h.service.dispatch(personCreated())
    const runId = String(result.decisions[0]?.runId)
    const run = h.runs.get(runId)

    // The executor is never reached: the denial happens before the action.
    expect(h.calls.createTask).toHaveLength(0)
    expect(run?.status).toBe("failed")
    expect(String(run?.error)).toContain("cannot 'create'")

    const steps = await h.store.listRunSteps(WS, runId)
    expect(steps[0]?.status).toBe("failed")
    const stepFailed = h.emitted.find((e) => e.event === AutomationEvents.StepFailed)
    expect((stepFailed?.after as { forbidden?: boolean } | undefined)?.forbidden).toBe(true)
  })

  test("the same definition owned by a member DOES perform the action", async () => {
    const h = makeHarness({ roles: ADMIN_ROLES, driveInline: true })
    seedWorkflow(h, { ownerId: "member_owner" })
    await h.service.dispatch(personCreated())
    expect(h.calls.createTask).toHaveLength(1)
    expect(h.calls.createTask[0]?.ctx.role).toBe("member")
  })

  test("the owner's LIVE role is used, so a demotion takes effect immediately", async () => {
    const h = makeHarness({ roles: { drifting: "member" }, driveInline: true })
    seedWorkflow(h, { ownerId: "drifting" })
    await h.service.dispatch(personCreated())
    expect(h.calls.createTask).toHaveLength(1)

    h.roles.drifting = "viewer"
    const second = await h.service.dispatch(personCreated())
    expect(h.runs.get(String(second.decisions[0]?.runId))?.status).toBe("failed")
    expect(h.calls.createTask).toHaveLength(1)
  })

  test("the action context carries the run correlation id for audit tracing", async () => {
    const h = makeHarness({ roles: ADMIN_ROLES, driveInline: true })
    seedWorkflow(h)
    const result = await h.service.dispatch(personCreated())
    const runId = String(result.decisions[0]?.runId)
    expect(h.calls.createTask[0]?.ctx.correlationId).toBe(workflowRunCorrelationId(runId))
    const runAudit = h.audits.find((a) => a.action === "run")
    expect(runAudit?.source).toBe("automation")
  })
})

/* ----------------------------- loop protection ---------------------------- */

describe("automation/loop-protection", () => {
  test("a workflow that triggers ITSELF terminates instead of running forever", async () => {
    // The workflow listens to person.updated and updates a field on the
    // person — which emits person.updated again. Without a depth ceiling
    // this is an infinite cascade.
    // The cascade re-enters the same service, so the dispatcher is bound
    // after construction (same reason as the inline queue above).
    let dispatch = async (_event: DomainEvent): Promise<unknown> => {
      throw new Error("cascade fired before the service was built")
    }
    const h = makeHarness({
      roles: ADMIN_ROLES,
      driveInline: true,
      onUpdateField: async (ctx, target) => {
        await dispatch({
          ...createEvent({
            event: CrmEvents.PersonUpdated,
            workspaceId: WS,
            actorId: ctx.actorId,
            actorType: "automation",
            entityType: target.entityType,
            entityId: target.entityId,
            after: { status: "hot" },
          }),
          // The action ran with the run's correlation id, so the event it
          // produced carries the cascade chain forward.
          correlationId: ctx.correlationId,
        })
      },
    })
    dispatch = h.service.dispatch
    seedWorkflow(h, {
      triggerEvent: CrmEvents.PersonUpdated,
      actions: [{ type: "update_field", field: "status", value: "hot" }],
    })

    await h.service.dispatch(
      createEvent({
        event: CrmEvents.PersonUpdated,
        workspaceId: WS,
        actorId: "user_1",
        entityType: "person",
        entityId: "person_1",
        after: { status: "warm" },
      }),
    )

    // Generations 0..MAX execute, generation MAX+1 is refused.
    expect(h.calls.updateRecordField).toHaveLength(WORKFLOW_MAX_CASCADE_DEPTH + 1)
    const depths = [...h.runs.values()].map((r) => r.depth).sort((a, b) => a - b)
    expect(depths).toEqual(Array.from({ length: WORKFLOW_MAX_CASCADE_DEPTH + 2 }, (_value, i) => i))
    const deepest = [...h.runs.values()].find((r) => r.depth === WORKFLOW_MAX_CASCADE_DEPTH + 1)
    expect(deepest?.status).toBe("skipped")
    expect(String(deepest?.error)).toContain("exceeds the maximum")
  })

  test("a run recorded past the ceiling is refused at execution too", async () => {
    const h = makeHarness({ roles: ADMIN_ROLES })
    const workflow = seedWorkflow(h)
    const { run } = await h.store.createRun(WS, {
      workflowId: workflow.id,
      triggerEventId: "evt_deep",
      triggerEvent: CrmEvents.PersonCreated,
      status: "queued",
      depth: WORKFLOW_MAX_CASCADE_DEPTH + 3,
      actorId: "owner_admin",
    })
    const outcome = await h.service.executeRun(WS, run.id)
    expect(outcome.status).toBe("skipped")
    expect(h.calls.createTask).toHaveLength(0)
  })

  test("depth comes from the parent run, not from the payload", async () => {
    const h = makeHarness({ roles: ADMIN_ROLES })
    const workflow = seedWorkflow(h)
    const { run: parent } = await h.store.createRun(WS, {
      workflowId: workflow.id,
      triggerEventId: "evt_parent",
      triggerEvent: CrmEvents.PersonCreated,
      status: "succeeded",
      depth: 2,
    })
    const result = await h.service.dispatch(
      personCreated({ correlationId: workflowRunCorrelationId(parent.id) }),
    )
    expect(result.depth).toBe(3)
    expect(h.runs.get(String(result.decisions[0]?.runId))?.parentRunId).toBe(parent.id)
  })
})

/* -------------------------------- wiring --------------------------------- */

describe("automation/bus-subscription", () => {
  test("the dispatcher subscribes to the bus and swallows its own failures", async () => {
    const h = makeHarness({ roles: ADMIN_ROLES, driveInline: true })
    seedWorkflow(h)
    const bus = new EventBus()
    const errors: unknown[] = []
    const unsubscribe = subscribeWorkflowDispatcher(bus, h.service, (err) => errors.push(err))

    await bus.emit(personCreated())
    expect(h.calls.createTask).toHaveLength(1)

    // A dispatcher blow-up must never fail the business write that caused it.
    const exploding = createWorkflowAutomationService({
      store: {
        ...h.store,
        listEnabledByTrigger: async () => {
          throw new PermissionDeniedError({ workspaceId: WS, actorId: "x", action: "read" })
        },
      },
      audit: async () => {},
      queue: { enqueueWorkflowRun: async () => {} },
      executor: createFakeExecutor().executor,
      resolveActorRole: async () => "admin",
    })
    const stop = subscribeWorkflowDispatcher(bus, exploding, (err) => errors.push(err))
    await bus.emit(personCreated())
    expect(errors).toHaveLength(1)

    unsubscribe()
    stop()
    expect(bus.listenerCount()).toBe(0)
  })
})
