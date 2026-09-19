import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import { createCalendarService, type CalendarService } from "@yourcrm/crm/src/calendar"
import type {
  CalendarAttendeeRecord,
  CalendarEventRecord,
  CalendarStore,
} from "@yourcrm/crm/src/calendar"
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
import { createRoutes } from "./calendar"

type StoredEvent = BaseRecord & { title: string; startAt: string; endAt: string }

function asRecord(row: StoredEvent): CalendarEventRecord {
  return row as unknown as CalendarEventRecord
}

/** Real domain service over a hermetic in-memory store. */
function makeFakeService(timezone = "America/New_York") {
  const eventStore = createStore<StoredEvent>()
  const attendees: CalendarAttendeeRecord[] = []
  const store: CalendarStore = {
    list: async (workspaceId, query) => {
      let rows = eventStore.list(workspaceId)
      if (query.from) rows = rows.filter((r) => r.endAt >= (query.from as string))
      if (query.to) rows = rows.filter((r) => r.startAt <= (query.to as string))
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
      const row = eventStore.get(id, workspaceId)
      return row ? asRecord(row) : null
    },
    findWithAttendees: async (workspaceId, id) => {
      const row = eventStore.get(id, workspaceId)
      if (!row) return null
      return { event: asRecord(row), attendees: attendees.filter((a) => a.eventId === id) }
    },
    create: async (workspaceId, input, actorId) => {
      const inserted = eventStore.insert({
        ...makeBaseRecord({ workspaceId }),
        title: input.title as string,
        startAt: input.startAt as string,
        endAt: input.endAt as string,
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      })
      for (const a of (input.attendees as Record<string, unknown>[] | undefined) ?? []) {
        attendees.push({
          id: crypto.randomUUID(),
          eventId: inserted.id,
          userId: (a.userId as string | null) ?? null,
          email: (a.email as string | null) ?? null,
        })
      }
      return asRecord(inserted)
    },
    update: async (workspaceId, id, input) => {
      const row = eventStore.update(id, workspaceId, input as Partial<StoredEvent>)
      return row ? asRecord(row) : null
    },
    softDelete: async (workspaceId, id) => {
      eventStore.remove(id, workspaceId)
    },
    restore: async (workspaceId, id) => {
      eventStore.restore(id, workspaceId)
    },
    getWorkspaceTimezone: async () => timezone,
  }
  return createCalendarService({ store, audit: async () => undefined })
}

/**
 * Hermetic API test: the route factory takes a service, so tests inject the
 * real domain service over an in-memory store. Sessions ride a tiny test-only
 * middleware (role-accurate without touching the foundation auth hook).
 */
function makeTestApp(session: { current: Session | null }, service: CalendarService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/calendar-events", createRoutes({ service }))
  return app
}

describe("api/calendar-events", () => {
  let session: { current: Session | null }
  let service: CalendarService
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
    const res = await api.get("/api/v1/calendar-events")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("list returns the cursor pagination envelope plus workspaceTimezone", async () => {
    await service.create(ctx, {
      title: "Kickoff",
      startAt: "2026-06-15T02:30:00.000Z",
      endAt: "2026-06-15T03:30:00.000Z",
    })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/calendar-events")
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })
    expect((body as unknown as { workspaceTimezone: string }).workspaceTimezone).toBe(
      "America/New_York",
    )
  })

  test("list supports from/to date-range query params", async () => {
    await service.create(ctx, {
      title: "June",
      startAt: "2026-06-15T02:30:00.000Z",
      endAt: "2026-06-15T03:30:00.000Z",
    })
    await service.create(ctx, {
      title: "July",
      startAt: "2026-07-15T02:30:00.000Z",
      endAt: "2026-07-15T03:30:00.000Z",
    })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get(
      "/api/v1/calendar-events?from=2026-06-01T00:00:00.000Z&to=2026-06-30T23:59:59.000Z",
    )
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    const data = body.data as { title: string }[]
    expect(data).toHaveLength(1)
    expect(data[0]?.title).toBe("June")
  })

  test("get returns the event with attendees; unknown id is NOT_FOUND", async () => {
    const created = await service.create(ctx, {
      title: "Kickoff",
      startAt: "2026-06-15T02:30:00.000Z",
      endAt: "2026-06-15T03:30:00.000Z",
      attendees: [{ email: "ext@example.com" }],
    })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const ok = await api.get(`/api/v1/calendar-events/${created.id}`)
    expect(ok.status).toBe(200)
    const data = ok.expectSuccess().data as { id: string; attendees: unknown[] }
    expect(data.id).toBe(created.id)
    expect(data.attendees).toHaveLength(1)
    const missing = await api.get("/api/v1/calendar-events/does-not-exist")
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")
  })

  test("create validates the body and returns 201", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const bad = await api.post("/api/v1/calendar-events", { title: "  " })
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")
    const good = await api.post("/api/v1/calendar-events", {
      title: "Kickoff",
      startAt: "2026-06-15T02:30:00.000Z",
      endAt: "2026-06-15T03:30:00.000Z",
    })
    expect(good.status).toBe(201)
    expect((good.expectSuccess().data as { title: string }).title).toBe("Kickoff")
  })

  test("create rejects endAt before startAt", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/calendar-events", {
      title: "Backwards",
      startAt: "2026-06-15T03:30:00.000Z",
      endAt: "2026-06-15T02:30:00.000Z",
    })
    expect(res.status).toBe(400)
    res.expectError("VALIDATION_ERROR")
  })

  test("viewer create is FORBIDDEN (service denial maps to 403)", async () => {
    session.current = makeSession({ role: "viewer", workspaceId: ctx.workspaceId })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/calendar-events", {
      title: "Nope",
      startAt: "2026-06-15T02:30:00.000Z",
      endAt: "2026-06-15T03:30:00.000Z",
    })
    expect(res.status).toBe(403)
    const err = res.expectError("FORBIDDEN")
    expect(err.error.message).toContain("create")
  })

  test("update, delete and restore round-trip", async () => {
    const created = await service.create(ctx, {
      title: "Kickoff",
      startAt: "2026-06-15T02:30:00.000Z",
      endAt: "2026-06-15T03:30:00.000Z",
    })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const patched = await api.patch(`/api/v1/calendar-events/${created.id}`, {
      location: "Room 4",
    })
    expect(patched.status).toBe(200)
    const deleted = await api.delete(`/api/v1/calendar-events/${created.id}`)
    expect(deleted.status).toBe(200)
    const gone = await api.get(`/api/v1/calendar-events/${created.id}`)
    expect(gone.status).toBe(404)
    const restored = await api.post(`/api/v1/calendar-events/${created.id}/restore`)
    expect(restored.status).toBe(200)
    const back = await api.get(`/api/v1/calendar-events/${created.id}`)
    expect(back.status).toBe(200)
  })
})
