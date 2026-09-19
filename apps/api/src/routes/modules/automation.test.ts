import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import {
  createWorkflowAutomationService,
  WORKFLOW_MAX_CASCADE_DEPTH,
  type WorkflowActionExecutorPort,
  type WorkflowAutomationService,
  type WorkflowAutomationStore,
  type WorkflowRecord,
  type WorkflowRunListQuery,
  type WorkflowRunRecord,
  type WorkflowRunStepRecord,
} from "@yourcrm/crm/src/automation"
import {
  validateWorkflowActions,
  WorkflowDefinitionError,
} from "@yourcrm/database/src/repositories/automation-repository"
import { CrmEvents, createEvent } from "@yourcrm/events"
import {
  createApiClient,
  createStore,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
  nextId,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes } from "./automation"

/**
 * Hermetic API test: the route factory takes a service, so this injects
 * the REAL domain service over an in-memory store that reproduces the two
 * UNIQUE indexes from migration 0190, plus the real definition validator
 * from `@yourcrm/database`. No Postgres, no Redis.
 *
 * The queue fake drives the run inline, so an HTTP call all the way
 * through to an executed action is observable in one test — including the
 * two negative paths that matter: a redelivered event acting once, and a
 * viewer-owned workflow being refused.
 */

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

function makeFakeService(options: { roles: Record<string, string> }) {
  const workflows = createStore<StoredWorkflow>()
  const runs = new Map<string, WorkflowRunRecord>()
  const runByEvent = new Map<string, string>()
  const steps = new Map<string, WorkflowRunStepRecord>()
  const stepByIndex = new Map<string, string>()
  const performed: { action: string; actorId: string; role?: string }[] = []
  const enqueued: string[] = []

  const store: WorkflowAutomationStore = {
    list: async (workspaceId, query) => {
      const rows = workflows.list(workspaceId)
      const limit = query.limit ?? 25
      return { data: rows.slice(0, limit).map(asWorkflow), pagination: { nextCursor: null, limit } }
    },
    findById: async (workspaceId, id) => {
      const row = workflows.get(id, workspaceId)
      return row ? asWorkflow(row) : null
    },
    create: async (workspaceId, input, actorId) => {
      // Real validator: an action the executor cannot perform is rejected
      // before it is ever stored.
      const actions = validateWorkflowActions(input.actions)
      return asWorkflow(
        workflows.insert({
          ...makeBaseRecord({ workspaceId }),
          name: String(input.name ?? ""),
          description: (input.description as string | null) ?? null,
          triggerEvent: String(input.triggerEvent ?? ""),
          triggerEntityType: (input.triggerEntityType as string | null) ?? null,
          conditions: input.conditions ?? null,
          actions,
          status: (input.status as string | null) ?? "disabled",
          ownerId: (input.ownerId as string | null) ?? actorId ?? null,
          lastRunAt: null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      )
    },
    update: async (workspaceId, id, input) => {
      if (input.actions !== undefined) validateWorkflowActions(input.actions)
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

  const executor: WorkflowActionExecutorPort = {
    createTask: async (ctx) => {
      performed.push({ action: "create_task", actorId: ctx.actorId, role: ctx.role })
      return { taskId: nextId("task") }
    },
    updateRecordField: async (ctx, target) => {
      performed.push({ action: "update_field", actorId: ctx.actorId, role: ctx.role })
      return { recordId: target.entityId }
    },
    addTag: async (ctx) => {
      performed.push({ action: "add_tag", actorId: ctx.actorId, role: ctx.role })
      return { tagId: nextId("tag") }
    },
    notify: async (ctx) => {
      performed.push({ action: "notify", actorId: ctx.actorId, role: ctx.role })
      return { notificationId: nextId("notif") }
    },
  }

  let executeRun = async (_workspaceId: string, _runId: string): Promise<unknown> => {
    throw new Error("queue drained before the service was built")
  }

  const service = createWorkflowAutomationService({
    store,
    audit: async () => {},
    events: { emit: async () => {} },
    queue: {
      enqueueWorkflowRun: async (request) => {
        enqueued.push(request.runId)
        await executeRun(request.workspaceId, request.runId)
      },
    },
    executor,
    resolveActorRole: async (_workspaceId, actorId) => options.roles[actorId] ?? null,
  })
  executeRun = service.executeRun

  return { service, store, workflows, runs, performed, enqueued }
}

function makeTestApp(session: { current: Session | null }, service: WorkflowAutomationService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/automation", createRoutes({ service }))
  return app
}

const DEFINITION = {
  name: "Welcome flow",
  triggerEvent: CrmEvents.PersonCreated,
  actions: [{ type: "create_task", title: "Call {{firstName}}" }],
}

describe("api/automation", () => {
  let session: { current: Session | null }
  let fake: ReturnType<typeof makeFakeService>
  let ctx: ReturnType<typeof makeServiceContext>
  let ownerId: string

  beforeEach(() => {
    const owner = makeSession({ role: "owner" })
    ctx = makeServiceContext({ session: owner })
    ownerId = ctx.actorId
    session = { current: owner }
    fake = makeFakeService({ roles: { [ownerId]: "owner" } })
  })

  const client = () => createApiClient({ app: makeTestApp(session, fake.service) })

  test("unauthenticated requests get UNAUTHORIZED", async () => {
    session.current = null
    const res = await client().get("/api/v1/automation")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("list returns the cursor pagination envelope", async () => {
    await fake.service.create(ctx, DEFINITION)
    const res = await client().get("/api/v1/automation")
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("the catalogue is served before the :id route", async () => {
    const res = await client().get("/api/v1/automation/catalogue")
    expect(res.status).toBe(200)
    const data = res.expectSuccess().data as {
      triggers: { event: string }[]
      actions: { type: string }[]
      targets: { objectType: string }[]
      maxCascadeDepth: number
    }
    expect(data.triggers.map((t) => t.event)).toContain(CrmEvents.DealStageChanged)
    // Engine events are never triggerable — the first line of loop defence.
    expect(data.triggers.map((t) => t.event)).not.toContain("workflow.completed")
    expect(data.actions.map((a) => a.type)).toEqual([
      "create_task",
      "update_field",
      "add_tag",
      "notify",
    ])
    expect(data.targets.map((t) => t.objectType)).toContain("person")
    expect(data.maxCascadeDepth).toBe(WORKFLOW_MAX_CASCADE_DEPTH)
  })

  test("create validates the body and returns 201, disabled", async () => {
    const api = client()
    const bad = await api.post("/api/v1/automation", { name: "  ", triggerEvent: "nope" })
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")

    const good = await api.post("/api/v1/automation", DEFINITION)
    expect(good.status).toBe(201)
    const created = good.expectSuccess().data as { name: string; status: string }
    expect(created.name).toBe("Welcome flow")
    expect(created.status).toBe("disabled")
  })

  test("an unknown trigger event is a 400, not a 500", async () => {
    const res = await client().post("/api/v1/automation", {
      ...DEFINITION,
      triggerEvent: "person.exploded",
    })
    expect(res.status).toBe(400)
    res.expectError("VALIDATION_ERROR")
  })

  test("an action type with no executor binding is a 400", async () => {
    const res = await client().post("/api/v1/automation", {
      ...DEFINITION,
      actions: [{ type: "send_email", to: "a@b.c" }],
    })
    expect(res.status).toBe(400)
    res.expectError("VALIDATION_ERROR")
  })

  test("get returns the definition; unknown id is NOT_FOUND", async () => {
    const created = await fake.service.create(ctx, DEFINITION)
    const api = client()
    const ok = await api.get(`/api/v1/automation/${created.id}`)
    expect(ok.status).toBe(200)
    const missing = await api.get("/api/v1/automation/does-not-exist")
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")
  })

  test("update, delete and restore round-trip", async () => {
    const created = await fake.service.create(ctx, DEFINITION)
    const api = client()
    expect((await api.patch(`/api/v1/automation/${created.id}`, { name: "Renamed" })).status).toBe(
      200,
    )
    expect((await api.delete(`/api/v1/automation/${created.id}`)).status).toBe(200)
    expect((await api.get(`/api/v1/automation/${created.id}`)).status).toBe(404)
    expect((await api.post(`/api/v1/automation/${created.id}/restore`, {})).status).toBe(200)
    expect((await api.get(`/api/v1/automation/${created.id}`)).status).toBe(200)
  })

  test("viewer create is FORBIDDEN (service denial maps to 403)", async () => {
    session.current = makeSession({ role: "viewer", workspaceId: ctx.workspaceId })
    const res = await client().post("/api/v1/automation", DEFINITION)
    expect(res.status).toBe(403)
    expect(res.expectError("FORBIDDEN").error.message).toContain("create")
  })

  test("a member cannot enable a workflow but can disable one", async () => {
    const created = await fake.service.create(ctx, DEFINITION)
    session.current = makeSession({ role: "member", workspaceId: ctx.workspaceId })
    const denied = await client().post(`/api/v1/automation/${created.id}/enable`, {})
    expect(denied.status).toBe(403)
    denied.expectError("FORBIDDEN")

    const allowed = await client().post(`/api/v1/automation/${created.id}/disable`, {})
    expect(allowed.status).toBe(200)
  })

  test("enable then manual run queues a run and performs the action", async () => {
    const created = await fake.service.create(ctx, DEFINITION)
    const api = client()
    expect((await api.post(`/api/v1/automation/${created.id}/enable`, {})).status).toBe(200)

    const run = await api.post(`/api/v1/automation/${created.id}/run`, {
      entityType: "person",
      entityId: "person_1",
      sample: { firstName: "Ada" },
    })
    expect(run.status).toBe(202)
    const dispatch = run.expectSuccess().data as { decisions: { outcome: string }[] }
    expect(dispatch.decisions[0]?.outcome).toBe("queued")
    expect(fake.performed.map((p) => p.action)).toEqual(["create_task"])
    // PERMISSION INHERITANCE: it ran as the workflow owner, at their role.
    expect(fake.performed[0]?.actorId).toBe(ownerId)
    expect(fake.performed[0]?.role).toBe("owner")
  })

  test("a member cannot fire a manual run", async () => {
    const created = await fake.service.create(ctx, DEFINITION)
    session.current = makeSession({ role: "member", workspaceId: ctx.workspaceId })
    const res = await client().post(`/api/v1/automation/${created.id}/run`, {})
    expect(res.status).toBe(403)
  })

  test("run history is readable per workflow and workspace-wide, with steps", async () => {
    const created = await fake.service.create(ctx, DEFINITION)
    await fake.service.setEnabled(ctx, created.id, true)
    await fake.service.dispatch(
      createEvent({
        event: CrmEvents.PersonCreated,
        workspaceId: ctx.workspaceId,
        entityType: "person",
        entityId: "person_1",
        after: { firstName: "Ada" },
      }),
    )
    const api = client()
    const all = await api.get("/api/v1/automation/runs")
    expect(all.status).toBe(200)
    const runs = all.expectSuccess().data as { id: string; status: string }[]
    expect(runs).toHaveLength(1)
    expect(runs[0]?.status).toBe("succeeded")

    const scoped = await api.get(`/api/v1/automation/${created.id}/runs`)
    expect((scoped.expectSuccess().data as unknown[]).length).toBe(1)

    const detail = await api.get(`/api/v1/automation/runs/${runs[0]?.id}`)
    expect(detail.status).toBe(200)
    const body = detail.expectSuccess().data as { steps: { actionType: string }[] }
    expect(body.steps.map((s) => s.actionType)).toEqual(["create_task"])

    const missing = await api.get("/api/v1/automation/runs/nope")
    expect(missing.status).toBe(404)
  })

  test("IDEMPOTENCY: the same event delivered twice performs the action once", async () => {
    const created = await fake.service.create(ctx, DEFINITION)
    await fake.service.setEnabled(ctx, created.id, true)
    const event = createEvent({
      event: CrmEvents.PersonCreated,
      workspaceId: ctx.workspaceId,
      entityType: "person",
      entityId: "person_1",
      after: { firstName: "Ada" },
    })

    await fake.service.dispatch(event)
    await fake.service.dispatch(event)

    expect(fake.enqueued).toHaveLength(1)
    expect(fake.performed).toHaveLength(1)
    const res = await client().get("/api/v1/automation/runs")
    expect((res.expectSuccess().data as unknown[]).length).toBe(1)
  })

  test("PERMISSION INHERITANCE: a viewer-owned workflow cannot create a task", async () => {
    const viewerOwned = makeFakeService({ roles: { [ownerId]: "viewer" } })
    const created = await viewerOwned.service.create(ctx, DEFINITION)
    // Enabled by an admin; the owner is still only a viewer.
    await viewerOwned.service.setEnabled(ctx, created.id, true)
    await viewerOwned.service.dispatch(
      createEvent({
        event: CrmEvents.PersonCreated,
        workspaceId: ctx.workspaceId,
        entityType: "person",
        entityId: "person_1",
        after: { firstName: "Ada" },
      }),
    )

    expect(viewerOwned.performed).toHaveLength(0)
    const run = [...viewerOwned.runs.values()][0]
    expect(run?.status).toBe("failed")
    expect(String(run?.error)).toContain("cannot 'create'")

    const api = createApiClient({ app: makeTestApp(session, viewerOwned.service) })
    const detail = await api.get(`/api/v1/automation/runs/${run?.id}`)
    const body = detail.expectSuccess().data as { status: string; steps: { status: string }[] }
    expect(body.status).toBe("failed")
    expect(body.steps[0]?.status).toBe("failed")
  })

  test("the definition validator rejects an over-long action list", () => {
    expect(() =>
      validateWorkflowActions(Array.from({ length: 21 }, () => ({ type: "add_tag", tag: "x" }))),
    ).toThrow(WorkflowDefinitionError)
  })
})
