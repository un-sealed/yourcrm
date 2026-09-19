import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import { createCalendarService, type CalendarService } from "@yourcrm/crm/src/calendar"
import type {
  CalendarAttendeeRecord,
  CalendarEventListQuery,
} from "@yourcrm/crm/src/calendar/types"
import { createBookingLinksService, type BookingLinksService } from "@yourcrm/crm/src/booking-links"
import type {
  BookingAvailabilityRuleRecord,
  BookingBusyInterval,
  BookingLinksStore,
} from "@yourcrm/crm/src/booking-links"
import {
  createApiClient,
  freezeTime,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes, resetBookRateLimits } from "./booking-links"

/**
 * Hermetic API test: mirrors `people.test.ts` / `forms.test.ts` — the route
 * factory takes a service, so tests inject the real domain service over an
 * in-memory store (never a live Postgres — `docs/conventions.md`). The
 * calendar half uses the REAL `createCalendarService` over its own hermetic
 * store, so "a confirmed booking creates a calendar event through the
 * calendar service" is proven end-to-end through HTTP, not mocked away.
 */

type StoredLink = BaseRecord & {
  ownerId: string
  slug: string
  title: string
  description: string | null
  durationMinutes: number
  bufferBeforeMinutes: number
  bufferAfterMinutes: number
  minNoticeMinutes: number
  maxDaysAhead: number
  location: string | null
  status: string
}

type StoredBooking = BaseRecord & {
  bookingLinkId: string
  startsAt: string
  endsAt: string
  inviteeName: string
  inviteeEmail: string
  inviteeTimezone: string
  status: string
  calendarEventId: string | null
  notes: string | null
  cancellationReason: string | null
}

function slotTakenError(): Error {
  return Object.assign(new Error("booking.create: slot already taken"), {
    code: "BOOKING_SLOT_TAKEN",
  })
}

function makeBookingLinksStore() {
  const links = new Map<string, StoredLink>()
  const rulesByLink = new Map<string, BookingAvailabilityRuleRecord[]>()
  const bookings = new Map<string, StoredBooking>()
  const confirmedKeys = new Set<string>()
  const workspaceTimezone = "America/New_York"

  const asLink = (row: StoredLink) =>
    row as unknown as Record<string, unknown> & { id: string; workspaceId: string }
  const asBooking = (row: StoredBooking) =>
    row as unknown as Record<string, unknown> & { id: string; bookingLinkId: string }

  const store: BookingLinksStore = {
    list: async (workspaceId, query) => {
      let rows = [...links.values()].filter((r) => r.workspaceId === workspaceId && !r.deletedAt)
      if (query.status) rows = rows.filter((r) => r.status === query.status)
      const limit = query.limit ?? 25
      return { data: rows.slice(0, limit).map(asLink), pagination: { nextCursor: null, limit } }
    },
    findById: async (workspaceId, id) => {
      const row = links.get(id)
      return row && row.workspaceId === workspaceId && !row.deletedAt ? asLink(row) : null
    },
    findWithRules: async (workspaceId, id) => {
      const row = links.get(id)
      if (!row || row.workspaceId !== workspaceId || row.deletedAt) return null
      return { bookingLink: asLink(row), rules: rulesByLink.get(id) ?? [] }
    },
    findActiveBySlug: async (slug) => {
      const row = [...links.values()].find(
        (r) => r.slug === slug && r.status === "active" && !r.deletedAt,
      )
      if (!row) return null
      return { bookingLink: asLink(row), rules: rulesByLink.get(row.id) ?? [] }
    },
    create: async (workspaceId, input, actorId) => {
      const base = makeBaseRecord({ workspaceId })
      const record: StoredLink = {
        ...base,
        ownerId: input.ownerId as string,
        slug: input.slug as string,
        title: input.title as string,
        description: (input.description as string | null) ?? null,
        durationMinutes: input.durationMinutes as number,
        bufferBeforeMinutes: (input.bufferBeforeMinutes as number | undefined) ?? 0,
        bufferAfterMinutes: (input.bufferAfterMinutes as number | undefined) ?? 0,
        minNoticeMinutes: (input.minNoticeMinutes as number | undefined) ?? 60,
        maxDaysAhead: (input.maxDaysAhead as number | undefined) ?? 30,
        location: (input.location as string | null) ?? null,
        status: (input.status as string | null) ?? "active",
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      }
      links.set(record.id, record)
      const rules =
        (input.rules as { dayOfWeek: number; startMinute: number; endMinute: number }[]) ?? []
      if (rules.length > 0) {
        rulesByLink.set(
          record.id,
          rules.map((r) => ({ id: crypto.randomUUID(), bookingLinkId: record.id, ...r })),
        )
      }
      return asLink(record)
    },
    update: async (workspaceId, id, input) => {
      const row = links.get(id)
      if (!row || row.workspaceId !== workspaceId || row.deletedAt) return null
      const next: StoredLink = {
        ...row,
        ...(input as Partial<StoredLink>),
        updatedAt: new Date().toISOString(),
      }
      links.set(id, next)
      return asLink(next)
    },
    softDelete: async (workspaceId, id) => {
      const row = links.get(id)
      if (row && row.workspaceId === workspaceId)
        links.set(id, { ...row, deletedAt: new Date().toISOString() })
    },
    restore: async (workspaceId, id) => {
      const row = links.get(id)
      if (row && row.workspaceId === workspaceId) links.set(id, { ...row, deletedAt: null })
    },
    replaceRules: async (workspaceId, bookingLinkId, rules) => {
      const out = rules.map((r) => ({ id: crypto.randomUUID(), bookingLinkId, ...r }))
      rulesByLink.set(bookingLinkId, out)
      return out
    },
    getWorkspaceTimezone: async () => workspaceTimezone,
    listBookings: async (workspaceId, bookingLinkId, query) => {
      let rows = [...bookings.values()].filter(
        (b) => b.workspaceId === workspaceId && b.bookingLinkId === bookingLinkId && !b.deletedAt,
      )
      if (query.status) rows = rows.filter((b) => b.status === query.status)
      const limit = query.limit ?? 25
      return { data: rows.slice(0, limit).map(asBooking), pagination: { nextCursor: null, limit } }
    },
    listActiveBookingsInRange: async (bookingLinkId, fromUtc, toUtc) => {
      const out: BookingBusyInterval[] = []
      for (const b of bookings.values()) {
        if (b.bookingLinkId !== bookingLinkId || b.status !== "confirmed" || b.deletedAt) continue
        const s = new Date(b.startsAt)
        const e = new Date(b.endsAt)
        if (e.getTime() >= fromUtc.getTime() && s.getTime() <= toUtc.getTime()) {
          out.push({ startAt: s, endAt: e })
        }
      }
      return out
    },
    createBooking: async (workspaceId, bookingLinkId, input) => {
      const startsAt = new Date(input.startsAt)
      const endsAt = new Date(input.endsAt)
      const key = `${bookingLinkId}|${startsAt.toISOString()}`
      if (confirmedKeys.has(key)) throw slotTakenError()
      confirmedKeys.add(key)
      const base = makeBaseRecord({ workspaceId })
      const record: StoredBooking = {
        ...base,
        bookingLinkId,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        inviteeName: input.inviteeName,
        inviteeEmail: input.inviteeEmail,
        inviteeTimezone: input.inviteeTimezone,
        status: "confirmed",
        calendarEventId: null,
        notes: input.notes ?? null,
        cancellationReason: null,
      }
      bookings.set(record.id, record)
      return asBooking(record)
    },
    findBookingById: async (workspaceId, id) => {
      const row = bookings.get(id)
      return row && row.workspaceId === workspaceId && !row.deletedAt ? asBooking(row) : null
    },
    cancelBooking: async (workspaceId, id, reason) => {
      const row = bookings.get(id)
      if (!row || row.workspaceId !== workspaceId) return null
      confirmedKeys.delete(`${row.bookingLinkId}|${row.startsAt}`)
      const next: StoredBooking = {
        ...row,
        status: "cancelled",
        cancellationReason: reason ?? null,
      }
      bookings.set(id, next)
      return asBooking(next)
    },
    attachCalendarEvent: async (workspaceId, bookingId, calendarEventId) => {
      const row = bookings.get(bookingId)
      if (row && row.workspaceId === workspaceId)
        bookings.set(bookingId, { ...row, calendarEventId })
    },
  }

  return { links, store }
}

function makeCalendarService(timezone: string): CalendarService {
  type StoredEvent = BaseRecord & {
    title: string
    description: string | null
    location: string | null
    startAt: string
    endAt: string
    allDay: boolean
    status: string
    ownerId: string | null
    personId: string | null
    companyId: string | null
    dealId: string | null
  }
  const events = new Map<string, StoredEvent>()
  const attendees: CalendarAttendeeRecord[] = []
  const asEvent = (row: StoredEvent) =>
    row as unknown as import("@yourcrm/crm/src/calendar/types").CalendarEventRecord

  return createCalendarService({
    store: {
      list: async (workspaceId, query: CalendarEventListQuery) => {
        let rows = [...events.values()].filter((r) => r.workspaceId === workspaceId && !r.deletedAt)
        if (query.status) rows = rows.filter((r) => r.status === query.status)
        if (query.from) rows = rows.filter((r) => r.endAt >= (query.from as string))
        if (query.to) rows = rows.filter((r) => r.startAt <= (query.to as string))
        const limit = query.limit ?? 25
        return { data: rows.slice(0, limit).map(asEvent), pagination: { nextCursor: null, limit } }
      },
      findById: async (workspaceId, id) => {
        const row = events.get(id)
        return row && row.workspaceId === workspaceId ? asEvent(row) : null
      },
      findWithAttendees: async (workspaceId, id) => {
        const row = events.get(id)
        if (!row || row.workspaceId !== workspaceId) return null
        return { event: asEvent(row), attendees: attendees.filter((a) => a.eventId === id) }
      },
      create: async (workspaceId, input, actorId) => {
        const base = makeBaseRecord({ workspaceId })
        const record: StoredEvent = {
          ...base,
          title: input.title as string,
          description: (input.description as string | null) ?? null,
          location: (input.location as string | null) ?? null,
          startAt: input.startAt as string,
          endAt: input.endAt as string,
          allDay: (input.allDay as boolean | undefined) ?? false,
          status: (input.status as string | null) ?? "confirmed",
          ownerId: (input.ownerId as string | null) ?? null,
          personId: null,
          companyId: null,
          dealId: null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }
        events.set(record.id, record)
        return asEvent(record)
      },
      update: async (workspaceId, id, input) => {
        const row = events.get(id)
        if (!row || row.workspaceId !== workspaceId) return null
        const next = { ...row, ...(input as Partial<StoredEvent>) }
        events.set(id, next)
        return asEvent(next)
      },
      softDelete: async (workspaceId, id) => {
        const row = events.get(id)
        if (row && row.workspaceId === workspaceId) events.delete(id)
      },
      restore: async () => undefined,
      getWorkspaceTimezone: async () => timezone,
    },
    audit: async () => undefined,
  })
}

function makeFakeService() {
  const backing = makeBookingLinksStore()
  const calendar = makeCalendarService("America/New_York")
  const service = createBookingLinksService({
    store: backing.store,
    audit: async () => undefined,
    calendar,
  })
  return { service, backing }
}

function makeTestApp(session: { current: Session | null }, service: BookingLinksService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/booking-links", createRoutes({ service }))
  return app
}

async function seedLink(service: BookingLinksService, ctx: ReturnType<typeof makeServiceContext>) {
  return service.create(ctx, {
    ownerId: ctx.actorId,
    slug: "ada-30min",
    title: "30 minute chat",
    durationMinutes: 30,
    minNoticeMinutes: 0,
    rules: [{ dayOfWeek: 1, startMinute: 540, endMinute: 1020 }], // Mon 09:00-17:00 local
  })
}

describe("api/booking-links management", () => {
  let session: { current: Session | null }
  let service: BookingLinksService
  let ctx: ReturnType<typeof makeServiceContext>

  beforeEach(() => {
    resetBookRateLimits()
    const owner = makeSession({ role: "owner" })
    ctx = makeServiceContext({ session: owner })
    session = { current: owner }
    service = makeFakeService().service
  })

  test("unauthenticated requests get UNAUTHORIZED", async () => {
    session.current = null
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/booking-links")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("create validates the body and returns 201; list returns the cursor envelope", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const bad = await api.post("/api/v1/booking-links", { title: "" })
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")
    const good = await api.post("/api/v1/booking-links", {
      ownerId: ctx.actorId,
      slug: "ada-30min",
      title: "30 minute chat",
      durationMinutes: 30,
    })
    expect(good.status).toBe(201)
    const list = await api.get("/api/v1/booking-links")
    expect(list.status).toBe(200)
    expect(list.expectSuccess().data).toHaveLength(1)
  })

  test("viewer create is FORBIDDEN (service denial maps to 403)", async () => {
    session.current = makeSession({ role: "viewer", workspaceId: ctx.workspaceId })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/booking-links", {
      ownerId: ctx.actorId,
      slug: "nope-30",
      title: "Nope",
      durationMinutes: 30,
    })
    expect(res.status).toBe(403)
    res.expectError("FORBIDDEN")
  })

  test("get, update, replace rules, delete and restore round-trip", async () => {
    const link = await seedLink(service, ctx)
    const api = createApiClient({ app: makeTestApp(session, service) })
    const got = await api.get(`/api/v1/booking-links/${link.id}`)
    expect(got.status).toBe(200)
    const patched = await api.patch(`/api/v1/booking-links/${link.id}`, { title: "New title" })
    expect(patched.status).toBe(200)
    const rules = await api.put(`/api/v1/booking-links/${link.id}/rules`, {
      rules: [{ dayOfWeek: 2, startMinute: 600, endMinute: 660 }],
    })
    expect(rules.status).toBe(200)
    expect(rules.expectSuccess().data).toHaveLength(1)
    const deleted = await api.delete(`/api/v1/booking-links/${link.id}`)
    expect(deleted.status).toBe(200)
    const gone = await api.get(`/api/v1/booking-links/${link.id}`)
    expect(gone.status).toBe(404)
    const restored = await api.post(`/api/v1/booking-links/${link.id}/restore`)
    expect(restored.status).toBe(200)
  })
})

describe("api/booking-links public surface", () => {
  let clock: ReturnType<typeof freezeTime>
  let session: { current: Session | null }
  let service: BookingLinksService
  let ctx: ReturnType<typeof makeServiceContext>

  beforeEach(async () => {
    resetBookRateLimits()
    clock = freezeTime("2026-06-01T00:00:00.000Z")
    const owner = makeSession({ role: "owner" })
    ctx = makeServiceContext({ session: owner })
    session = { current: null } // public endpoints: no session
    service = makeFakeService().service
    await seedLink(service, ctx)
  })

  afterEach(() => {
    clock.restore()
  })

  test("public link lookup exposes only safe fields — no owner/workspace identity", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/booking-links/public/ada-30min")
    expect(res.status).toBe(200)
    const data = res.expectSuccess().data as Record<string, unknown>
    expect(Object.keys(data).sort()).toEqual(
      ["description", "durationMinutes", "location", "slug", "title", "workspaceTimezone"].sort(),
    )
    expect(data).not.toHaveProperty("ownerId")
    expect(data).not.toHaveProperty("workspaceId")
    expect(data).not.toHaveProperty("id")
  })

  test("public lookup 404s for an unknown slug", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/booking-links/public/does-not-exist")
    expect(res.status).toBe(404)
    res.expectError("NOT_FOUND")
  })

  test("public availability returns only start/end instants", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get(
      "/api/v1/booking-links/public/ada-30min/availability?from=2026-06-15&to=2026-06-15&timezone=America%2FNew_York",
    )
    expect(res.status).toBe(200)
    const data = res.expectSuccess().data as { startAt: string; endAt: string }[]
    expect(data.length).toBeGreaterThan(0)
    for (const slot of data) expect(Object.keys(slot).sort()).toEqual(["endAt", "startAt"])
  })

  test("public booking succeeds and echoes only the invitee's own submission", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/booking-links/public/ada-30min/book", {
      startAt: "2026-06-15T13:00:00.000Z",
      inviteeName: "Grace Hopper",
      inviteeEmail: "grace@example.com",
      inviteeTimezone: "America/New_York",
    })
    expect(res.status).toBe(201)
    const data = res.expectSuccess().data as Record<string, unknown>
    expect(data.status).toBe("confirmed")
    expect(data.inviteeName).toBe("Grace Hopper")
    // No calendar/owner internals leak into the public confirmation.
    expect(data).not.toHaveProperty("calendarEventId")
    expect(data).not.toHaveProperty("workspaceId")
    expect(data).not.toHaveProperty("bookingLinkId")
  })

  test("DOUBLE BOOKING over HTTP: the second concurrent POST for the same slot gets 409 CONFLICT", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const body = {
      startAt: "2026-06-15T14:00:00.000Z",
      inviteeTimezone: "America/New_York",
    }
    const [first, second] = await Promise.all([
      api.post("/api/v1/booking-links/public/ada-30min/book", {
        ...body,
        inviteeName: "First Invitee",
        inviteeEmail: "first@example.com",
      }),
      api.post("/api/v1/booking-links/public/ada-30min/book", {
        ...body,
        inviteeName: "Second Invitee",
        inviteeEmail: "second@example.com",
      }),
    ])
    const statuses = [first.status, second.status].sort()
    expect(statuses).toEqual([201, 409])
    const loser = first.status === 409 ? first : second
    loser.expectError("CONFLICT")
  })

  test("public booking is rate-limited per slug+IP", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    // Each attempt uses a distinct off-grid time so failures are all
    // VALIDATION-adjacent (BOOKING_SLOT_UNAVAILABLE), not slot conflicts —
    // rate limiting must trigger regardless of booking outcome.
    for (let i = 0; i < 20; i++) {
      const res = await api.post("/api/v1/booking-links/public/ada-30min/book", {
        startAt: `2026-06-15T13:0${i % 10}:00.000Z`,
        inviteeName: "Probe",
        inviteeEmail: "probe@example.com",
        inviteeTimezone: "America/New_York",
      })
      expect(res.status).not.toBe(429)
    }
    const limited = await api.post("/api/v1/booking-links/public/ada-30min/book", {
      startAt: "2026-06-15T15:00:00.000Z",
      inviteeName: "Probe",
      inviteeEmail: "probe@example.com",
      inviteeTimezone: "America/New_York",
    })
    expect(limited.status).toBe(429)
  })
})
