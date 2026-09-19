import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import { createActivitiesService, type ActivitiesService } from "@yourcrm/crm/src/activities"
import type { ActivitiesStore, ActivityRecord } from "@yourcrm/crm/src/activities"
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
import { createRoutes } from "./activities"

type StoredActivity = BaseRecord & {
  title: string
  type: string
  status: string
  subjectType: string | null
  subjectId: string | null
}

function asRecord(row: StoredActivity): ActivityRecord {
  return row as unknown as ActivityRecord
}

/** Real domain service over a hermetic in-memory store. */
function makeFakeService() {
  const activities = createStore<StoredActivity>()
  const store: ActivitiesStore = {
    list: async (workspaceId, query) => {
      const rows = activities.list(workspaceId)
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
    timeline: async (workspaceId, query) => {
      const rows = activities
        .list(workspaceId)
        .filter((r) => r.subjectType === query.subjectType && r.subjectId === query.subjectId)
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
      const row = activities.get(id, workspaceId)
      return row ? asRecord(row) : null
    },
    create: async (workspaceId, input, actorId) => {
      return asRecord(
        activities.insert({
          ...makeBaseRecord({ workspaceId }),
          title: input.title as string,
          type: "note",
          status: "open",
          subjectType: null,
          subjectId: null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      )
    },
    update: async (workspaceId, id, input) => {
      const row = activities.update(id, workspaceId, input as Partial<StoredActivity>)
      return row ? asRecord(row) : null
    },
    complete: async (workspaceId, id) => {
      const row = activities.update(id, workspaceId, { status: "completed" })
      return row ? asRecord(row) : null
    },
    softDelete: async (workspaceId, id) => {
      activities.remove(id, workspaceId)
    },
    restore: async (workspaceId, id) => {
      activities.restore(id, workspaceId)
    },
  }
  return createActivitiesService({ store, audit: async () => undefined })
}

/**
 * Hermetic API test: the route factory takes a service, so tests inject the
 * real domain service over an in-memory store. Sessions ride a tiny test-only
 * middleware (role-accurate without touching the foundation auth hook).
 */
function makeTestApp(session: { current: Session | null }, service: ActivitiesService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/activities", createRoutes({ service }))
  return app
}

describe("api/activities", () => {
  let session: { current: Session | null }
  let service: ActivitiesService
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
    const res = await api.get("/api/v1/activities")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("list returns the cursor pagination envelope", async () => {
    await service.create(ctx, { title: "Call Ada" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/activities")
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("get returns the activity; unknown id is NOT_FOUND", async () => {
    const created = await service.create(ctx, { title: "Call Ada" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const ok = await api.get(`/api/v1/activities/${created.id}`)
    expect(ok.status).toBe(200)
    const data = ok.expectSuccess().data as { id: string }
    expect(data.id).toBe(created.id)
    const missing = await api.get("/api/v1/activities/does-not-exist")
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")
  })

  test("create validates the body and returns 201", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const bad = await api.post("/api/v1/activities", { title: "  " })
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")
    const good = await api.post("/api/v1/activities", { title: "Call Ada", type: "call" })
    expect(good.status).toBe(201)
    expect((good.expectSuccess().data as { title: string }).title).toBe("Call Ada")
  })

  test("viewer create is FORBIDDEN (service denial maps to 403)", async () => {
    session.current = makeSession({ role: "viewer", workspaceId: ctx.workspaceId })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/activities", { title: "Nope" })
    expect(res.status).toBe(403)
    const err = res.expectError("FORBIDDEN")
    expect(err.error.message).toContain("create")
  })

  test("update, complete, delete and restore round-trip", async () => {
    const created = await service.create(ctx, { title: "Call Ada" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const patched = await api.patch(`/api/v1/activities/${created.id}`, { title: "Met Ada" })
    expect(patched.status).toBe(200)
    const completed = await api.post(`/api/v1/activities/${created.id}/complete`)
    expect(completed.status).toBe(200)
    expect((completed.expectSuccess().data as { status: string }).status).toBe("completed")
    const deleted = await api.delete(`/api/v1/activities/${created.id}`)
    expect(deleted.status).toBe(200)
    const gone = await api.get(`/api/v1/activities/${created.id}`)
    expect(gone.status).toBe(404)
    const restored = await api.post(`/api/v1/activities/${created.id}/restore`)
    expect(restored.status).toBe(200)
    const back = await api.get(`/api/v1/activities/${created.id}`)
    expect(back.status).toBe(200)
  })

  test("timeline requires subjectType and subjectId", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const bad = await api.get("/api/v1/activities/timeline")
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")
    const ok = await api.get("/api/v1/activities/timeline?subjectType=person&subjectId=person-1")
    expect(ok.status).toBe(200)
    expect(ok.expectSuccess().data).toEqual([])
  })
})
