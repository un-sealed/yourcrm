import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import { createTasksService, type TasksService } from "@yourcrm/crm/src/tasks"
import type { TasksStore, TaskRecord } from "@yourcrm/crm/src/tasks"
import {
  createApiClient,
  createStore,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes } from "./tasks"

type StoredTask = BaseRecord & {
  title: string
  description: string | null
  status: string
  priority: string
  dueDate: string | null
  completedAt: string | null
  assigneeId: string | null
}

function asRecord(row: StoredTask): TaskRecord {
  return row as unknown as TaskRecord
}

/** Real domain service over a hermetic in-memory store. */
function makeFakeService() {
  const tasks = createStore<StoredTask>()
  const store: TasksStore = {
    list: async (workspaceId, query) => {
      let rows = tasks.list(workspaceId)
      if (query.status) rows = rows.filter((r) => r.status === query.status)
      if (query.priority) rows = rows.filter((r) => r.priority === query.priority)
      if (query.assigneeId) rows = rows.filter((r) => r.assigneeId === query.assigneeId)
      const limit = query.limit ?? 25
      const data = rows.slice(0, limit)
      return {
        data: data.map(asRecord),
        pagination: {
          nextCursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null,
          limit,
        },
      }
    },
    findById: async (workspaceId, id) => {
      const row = tasks.get(id, workspaceId)
      return row ? asRecord(row) : null
    },
    create: async (workspaceId, input, actorId) => {
      return asRecord(
        tasks.insert({
          ...makeBaseRecord({ workspaceId }),
          title: input.title as string,
          description: (input.description as string | null) ?? null,
          status: (input.status as string | null) ?? "open",
          priority: (input.priority as string | null) ?? "medium",
          dueDate: null,
          completedAt: null,
          assigneeId: (input.assigneeId as string | null) ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      )
    },
    update: async (workspaceId, id, input) => {
      const row = tasks.update(id, workspaceId, input as Partial<StoredTask>)
      return row ? asRecord(row) : null
    },
    softDelete: async (workspaceId, id) => {
      tasks.remove(id, workspaceId)
    },
    restore: async (workspaceId, id) => {
      tasks.restore(id, workspaceId)
    },
  }
  return createTasksService({ store, audit: async () => undefined })
}

/**
 * Hermetic API test: the route factory takes a service, so tests inject the
 * real domain service over an in-memory store. Sessions ride a tiny test-only
 * middleware (role-accurate without touching the foundation auth hook).
 */
function makeTestApp(session: { current: Session | null }, service: TasksService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/tasks", createRoutes({ service }))
  return app
}

describe("api/tasks", () => {
  let session: { current: Session | null }
  let service: TasksService
  let ctx: ReturnType<typeof makeServiceContext>

  beforeEach(() => {
    const owner = makeSession({ role: "owner" })
    ctx = makeServiceContext({ session: owner })
    session = { current: owner }
    service = makeFakeService()
  })

  test("unauthenticated requests get UNAUTHORIZED", async () => {
    session.current = null
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/tasks")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("list returns the cursor pagination envelope", async () => {
    await service.create(ctx, { title: "Follow up" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/tasks")
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("get returns the task; unknown id is NOT_FOUND", async () => {
    const created = await service.create(ctx, { title: "Follow up" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const ok = await api.get(`/api/v1/tasks/${created.id}`)
    expect(ok.status).toBe(200)
    const data = ok.expectSuccess().data as { id: string; title: string }
    expect(data.id).toBe(created.id)
    expect(data.title).toBe("Follow up")
    const missing = await api.get("/api/v1/tasks/does-not-exist")
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")
  })

  test("create validates the body and returns 201", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const bad = await api.post("/api/v1/tasks", { title: "  " })
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")
    const good = await api.post("/api/v1/tasks", { title: "Follow up", priority: "high" })
    expect(good.status).toBe(201)
    expect((good.expectSuccess().data as { title: string }).title).toBe("Follow up")
  })

  test("viewer create is FORBIDDEN (service denial maps to 403)", async () => {
    session.current = makeSession({ role: "viewer", workspaceId: ctx.workspaceId })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/tasks", { title: "Nope" })
    expect(res.status).toBe(403)
    const err = res.expectError("FORBIDDEN")
    expect(err.error.message).toContain("create")
  })

  test("complete and reopen round-trip", async () => {
    const created = await service.create(ctx, { title: "Follow up" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const done = await api.post(`/api/v1/tasks/${created.id}/complete`)
    expect(done.status).toBe(200)
    expect((done.expectSuccess().data as { status: string }).status).toBe("completed")
    const open = await api.post(`/api/v1/tasks/${created.id}/reopen`)
    expect(open.status).toBe(200)
    expect((open.expectSuccess().data as { status: string }).status).toBe("open")
  })

  test("update, delete and restore round-trip", async () => {
    const created = await service.create(ctx, { title: "Follow up" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const patched = await api.patch(`/api/v1/tasks/${created.id}`, { priority: "urgent" })
    expect(patched.status).toBe(200)
    const deleted = await api.delete(`/api/v1/tasks/${created.id}`)
    expect(deleted.status).toBe(200)
    const gone = await api.get(`/api/v1/tasks/${created.id}`)
    expect(gone.status).toBe(404)
    const restored = await api.post(`/api/v1/tasks/${created.id}/restore`)
    expect(restored.status).toBe(200)
    const back = await api.get(`/api/v1/tasks/${created.id}`)
    expect(back.status).toBe(200)
  })
})
