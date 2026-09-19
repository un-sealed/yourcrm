import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import {
  createNotificationsService,
  type NotificationsService,
} from "@yourcrm/crm/src/notifications"
import type {
  AppNotification,
  NotificationPreferenceRecord,
  NotificationPreferencesStore,
  NotificationsStore,
} from "@yourcrm/crm/src/notifications"
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
import { createRoutes } from "./notifications"

type StoredNotification = BaseRecord & {
  userId: string
  type: string
  title: string
  body: string | null
  readAt: string | null
}

function asNotification(row: StoredNotification): AppNotification {
  return row as unknown as AppNotification
}

/** Real domain service over a hermetic in-memory store, mirroring `routes/modules/people.test.ts`. */
function makeFakeService() {
  const rows = createStore<StoredNotification>()
  const prefs = new Map<string, NotificationPreferenceRecord>()

  const store: NotificationsStore = {
    list: async (workspaceId, userId, query) => {
      const all = rows.list(workspaceId).filter((r) => r.userId === userId)
      const limit = query.limit ?? 25
      const data = all.slice(0, limit)
      return {
        data: data.map(asNotification),
        pagination: {
          nextCursor: all.length > limit ? (data[data.length - 1]?.id ?? null) : null,
          limit,
        },
      }
    },
    countUnread: async (workspaceId, userId) =>
      rows.list(workspaceId).filter((r) => r.userId === userId && r.readAt === null).length,
    findById: async (workspaceId, userId, id) => {
      const row = rows.get(id, workspaceId)
      return row && row.userId === userId ? asNotification(row) : null
    },
    create: async (workspaceId, input, actorId) =>
      asNotification(
        rows.insert({
          ...makeBaseRecord({ workspaceId }),
          userId: input.userId,
          type: input.type,
          title: input.title,
          body: input.body ?? null,
          readAt: null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      ),
    markRead: async (workspaceId, userId, id) => {
      const row = rows.get(id, workspaceId)
      if (!row || row.userId !== userId) return null
      const readAt = row.readAt ?? new Date().toISOString()
      const updated = rows.update(id, workspaceId, { readAt } as Partial<StoredNotification>)
      return updated ? asNotification(updated) : null
    },
    markAllRead: async (workspaceId, userId) => {
      const unread = rows.list(workspaceId).filter((r) => r.userId === userId && r.readAt === null)
      const readAt = new Date().toISOString()
      for (const row of unread)
        rows.update(row.id, workspaceId, { readAt } as Partial<StoredNotification>)
      return { updated: unread.length }
    },
    softDelete: async (workspaceId, userId, id) => {
      const row = rows.get(id, workspaceId)
      if (row && row.userId === userId) rows.remove(id, workspaceId)
    },
  }

  const preferencesStore: NotificationPreferencesStore = {
    get: async (workspaceId, userId) => prefs.get(`${workspaceId}:${userId}`) ?? null,
    upsert: async (workspaceId, userId, patch) => {
      const key = `${workspaceId}:${userId}`
      const existing = prefs.get(key)
      const merged: NotificationPreferenceRecord = {
        id: existing?.id ?? nextId("pref"),
        workspaceId,
        userId,
        categories: { ...(existing?.categories ?? {}), ...(patch.categories ?? {}) },
        quietHoursEnabled: patch.quietHoursEnabled ?? existing?.quietHoursEnabled ?? false,
        quietHoursStart:
          patch.quietHoursStart !== undefined
            ? patch.quietHoursStart
            : (existing?.quietHoursStart ?? null),
        quietHoursEnd:
          patch.quietHoursEnd !== undefined
            ? patch.quietHoursEnd
            : (existing?.quietHoursEnd ?? null),
        timezone: patch.timezone ?? existing?.timezone ?? "UTC",
      }
      prefs.set(key, merged)
      return merged
    },
  }

  return createNotificationsService({ store, preferencesStore, audit: async () => undefined })
}

function makeTestApp(session: { current: Session | null }, service: NotificationsService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/notifications", createRoutes({ service }))
  return app
}

describe("api/notifications", () => {
  let session: { current: Session | null }
  let service: NotificationsService
  let ctx: ReturnType<typeof makeServiceContext>

  beforeEach(() => {
    const owner = makeSession({ role: "owner" })
    ctx = makeServiceContext({ session: owner })
    session = { current: owner }
    service = makeFakeService()
  })

  async function seed(title: string) {
    const created = await service.create(ctx, { userId: ctx.actorId, type: "general", title })
    if (!created) throw new Error("seed: notification was unexpectedly suppressed")
    return created
  }

  test("unauthenticated requests get UNAUTHORIZED", async () => {
    session.current = null
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/notifications")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("list returns the cursor pagination envelope, own notifications only", async () => {
    await service.create(ctx, { userId: ctx.actorId, type: "general", title: "Mine" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/notifications")
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("get returns the notification; unknown id is NOT_FOUND", async () => {
    const created = await seed("Mine")
    const api = createApiClient({ app: makeTestApp(session, service) })
    const ok = await api.get(`/api/v1/notifications/${created.id}`)
    expect(ok.status).toBe(200)
    expect((ok.expectSuccess().data as { id: string }).id).toBe(created.id)
    const missing = await api.get("/api/v1/notifications/does-not-exist")
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")
  })

  test("cross-user get is NOT_FOUND, never another user's data (property: own notifications only)", async () => {
    const created = await seed("Owner's")
    const other = makeSession({ role: "admin", workspaceId: ctx.workspaceId })
    const api = createApiClient({ app: makeTestApp({ current: other }, service) })
    const res = await api.get(`/api/v1/notifications/${created.id}`)
    expect(res.status).toBe(404)
    res.expectError("NOT_FOUND")
  })

  test("unread-count reflects unread rows only", async () => {
    const a = await seed("A")
    await seed("B")
    const api = createApiClient({ app: makeTestApp(session, service) })
    const before = await api.get("/api/v1/notifications/unread-count")
    expect((before.expectSuccess().data as { count: number }).count).toBe(2)
    await api.post(`/api/v1/notifications/${a.id}/read`)
    const after = await api.get("/api/v1/notifications/unread-count")
    expect((after.expectSuccess().data as { count: number }).count).toBe(1)
  })

  test("mark read is idempotent over HTTP", async () => {
    const created = await seed("A")
    const api = createApiClient({ app: makeTestApp(session, service) })
    const first = await api.post(`/api/v1/notifications/${created.id}/read`)
    expect(first.status).toBe(200)
    const firstReadAt = (first.expectSuccess().data as { readAt: string }).readAt
    const second = await api.post(`/api/v1/notifications/${created.id}/read`)
    expect(second.status).toBe(200)
    expect((second.expectSuccess().data as { readAt: string }).readAt).toBe(firstReadAt)
  })

  test("read-all marks every unread notification", async () => {
    await seed("A")
    await seed("B")
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/notifications/read-all")
    expect(res.status).toBe(200)
    expect((res.expectSuccess().data as { updated: number }).updated).toBe(2)
  })

  test("delete removes the notification", async () => {
    const created = await seed("A")
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.delete(`/api/v1/notifications/${created.id}`)
    expect(res.status).toBe(200)
    const gone = await api.get(`/api/v1/notifications/${created.id}`)
    expect(gone.status).toBe(404)
  })

  test("viewer mark-read/delete is FORBIDDEN (service denial maps to 403)", async () => {
    const created = await seed("A")
    session.current = makeSession({
      role: "viewer",
      workspaceId: ctx.workspaceId,
      userId: ctx.actorId,
    })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const readRes = await api.post(`/api/v1/notifications/${created.id}/read`)
    expect(readRes.status).toBe(403)
    readRes.expectError("FORBIDDEN")
    const deleteRes = await api.delete(`/api/v1/notifications/${created.id}`)
    expect(deleteRes.status).toBe(403)
  })

  test("preferences: default GET is null, PUT validates and round-trips", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const before = await api.get("/api/v1/notifications/preferences")
    expect(before.status).toBe(200)
    expect(before.expectSuccess().data).toBeNull()

    const badBody = await api.put("/api/v1/notifications/preferences", {})
    expect(badBody.status).toBe(400)
    badBody.expectError("VALIDATION_ERROR")

    const updated = await api.put("/api/v1/notifications/preferences", {
      quietHoursEnabled: true,
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
      timezone: "UTC",
    })
    expect(updated.status).toBe(200)
    const data = updated.expectSuccess().data as { quietHoursEnabled: boolean; timezone: string }
    expect(data.quietHoursEnabled).toBe(true)
    expect(data.timezone).toBe("UTC")

    const after = await api.get("/api/v1/notifications/preferences")
    expect((after.expectSuccess().data as { quietHoursEnabled: boolean }).quietHoursEnabled).toBe(
      true,
    )
  })
})
