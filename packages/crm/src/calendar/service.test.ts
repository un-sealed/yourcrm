import { beforeEach, describe, expect, test } from "bun:test"
import type { ServiceContext } from "../index"
import {
  captureEvents,
  createStore,
  expectAllowed,
  expectDenied,
  freezeTime,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { createCalendarService, type CalendarService, formatEventDateTime } from "./index"
import type { CalendarAttendeeRecord, CalendarAuditInput, CalendarEventListQuery } from "./types"

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

function asRecord(row: StoredEvent) {
  return row as unknown as import("./types").CalendarEventRecord
}

const DEFAULT_TIMEZONE = "America/New_York"

/** Hermetic CalendarStore port backed by the shared in-memory store. */
function makeStore(timezone = DEFAULT_TIMEZONE) {
  const eventStore = createStore<StoredEvent>()
  const attendees: CalendarAttendeeRecord[] = []
  return {
    eventStore,
    attendees,
    store: {
      list: async (workspaceId: string, query: CalendarEventListQuery) => {
        let rows = eventStore.list(workspaceId)
        if (query.status) rows = rows.filter((r) => r.status === query.status)
        if (query.from) rows = rows.filter((r) => r.endAt >= (query.from as string))
        if (query.to) rows = rows.filter((r) => r.startAt <= (query.to as string))
        if (query.query) {
          const q = query.query.toLowerCase()
          rows = rows.filter((r) => r.title.toLowerCase().includes(q))
        }
        const limit = Math.min(Math.max(query.limit ?? 25, 1), 200)
        const data = rows.slice(0, limit)
        return {
          data: data.map(asRecord),
          pagination: {
            nextCursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null,
            limit,
          },
        }
      },
      findById: async (workspaceId: string, id: string) => {
        const row = eventStore.get(id, workspaceId)
        return row ? asRecord(row) : null
      },
      findWithAttendees: async (workspaceId: string, id: string) => {
        const row = eventStore.get(id, workspaceId)
        if (!row) return null
        return { event: asRecord(row), attendees: attendees.filter((a) => a.eventId === id) }
      },
      create: async (workspaceId: string, input: Record<string, unknown>, actorId?: string) => {
        const record: StoredEvent = {
          ...makeBaseRecord({ workspaceId }),
          title: input.title as string,
          description: (input.description as string | null) ?? null,
          location: (input.location as string | null) ?? null,
          startAt: input.startAt as string,
          endAt: input.endAt as string,
          allDay: (input.allDay as boolean | undefined) ?? false,
          status: (input.status as string | null) ?? "confirmed",
          ownerId: (input.ownerId as string | null) ?? null,
          personId: (input.personId as string | null) ?? null,
          companyId: (input.companyId as string | null) ?? null,
          dealId: (input.dealId as string | null) ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }
        const inserted = eventStore.insert(record)
        for (const a of (input.attendees as Record<string, unknown>[] | undefined) ?? []) {
          attendees.push({
            id: crypto.randomUUID(),
            eventId: inserted.id,
            userId: (a.userId as string | null) ?? null,
            email: (a.email as string | null) ?? null,
            responseStatus: (a.responseStatus as string | null) ?? "needs_action",
          })
        }
        return asRecord(inserted)
      },
      update: async (
        workspaceId: string,
        id: string,
        input: Record<string, unknown>,
        _actorId?: string,
      ) => {
        const row = eventStore.update(id, workspaceId, input as Partial<StoredEvent>)
        return row ? asRecord(row) : null
      },
      softDelete: async (workspaceId: string, id: string) => {
        eventStore.remove(id, workspaceId)
      },
      restore: async (workspaceId: string, id: string) => {
        eventStore.restore(id, workspaceId)
      },
      getWorkspaceTimezone: async () => timezone,
    },
  }
}

function setup(
  role: "owner" | "admin" | "member" | "viewer" = "owner",
  shared?: ReturnType<typeof makeStore>,
  workspaceId?: string,
) {
  const session = makeSession({ role, ...(workspaceId === undefined ? {} : { workspaceId }) })
  const ctx = makeServiceContext({ session })
  const audits: CalendarAuditInput[] = []
  const backing = shared ?? makeStore()
  const service = createCalendarService({
    store: backing.store,
    audit: async (input) => void audits.push(input),
  })
  return { ctx, service, audits, session, backing }
}

async function seed(
  service: CalendarService,
  ctx: ServiceContext,
  overrides: Partial<{ title: string; startAt: string; endAt: string; allDay: boolean }> = {},
) {
  return service.create(ctx, {
    title: overrides.title ?? "Kickoff",
    startAt: overrides.startAt ?? "2026-06-15T02:30:00.000Z",
    endAt: overrides.endAt ?? "2026-06-15T03:30:00.000Z",
    allDay: overrides.allDay ?? false,
  })
}

describe("calendar/service", () => {
  test("create validates, emits calendar.event_created and audits with after", async () => {
    const { ctx, service, audits } = setup()
    const events = captureEvents()
    try {
      const event = await expectAllowed(() => seed(service, ctx))
      expect(event.title).toBe("Kickoff")
      events.expectEmitted("calendar.event_created", {
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "calendar_event",
        entityId: event.id,
      })
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({
        workspaceId: ctx.workspaceId,
        action: "create",
        object: "calendar_event",
        recordId: event.id,
      })
      expect(audits[0]?.after).toMatchObject({ title: "Kickoff" })
    } finally {
      events.release()
    }
  })

  test("create rejects invalid input before touching the store", async () => {
    const { ctx, service } = setup()
    await expect(service.create(ctx, { title: "" })).rejects.toThrow()
  })

  test("create rejects endAt before startAt", async () => {
    const { ctx, service } = setup()
    await expect(
      service.create(ctx, {
        title: "Backwards",
        startAt: "2026-06-15T03:30:00.000Z",
        endAt: "2026-06-15T02:30:00.000Z",
      }),
    ).rejects.toThrow()
  })

  test("create stores an internal attendee (userId) and an external one (email)", async () => {
    const { ctx, service } = setup()
    const event = await service.create(ctx, {
      title: "Sync",
      startAt: "2026-06-15T02:30:00.000Z",
      endAt: "2026-06-15T03:30:00.000Z",
      attendees: [{ userId: "11111111-1111-4111-8111-111111111111" }, { email: "ext@example.com" }],
    })
    const found = await expectAllowed(() => service.get(ctx, event.id))
    expect(found.attendees).toHaveLength(2)
    expect(found.attendees.some((a) => a.userId === "11111111-1111-4111-8111-111111111111")).toBe(
      true,
    )
    expect(found.attendees.some((a) => a.email === "ext@example.com")).toBe(true)
  })

  test("create rejects an attendee with both userId and email, and with neither", async () => {
    const { ctx, service } = setup()
    await expect(
      service.create(ctx, {
        title: "Bad attendee",
        startAt: "2026-06-15T02:30:00.000Z",
        endAt: "2026-06-15T03:30:00.000Z",
        attendees: [{ userId: "u1", email: "both@example.com" }],
      }),
    ).rejects.toThrow()
    await expect(
      service.create(ctx, {
        title: "No attendee target",
        startAt: "2026-06-15T02:30:00.000Z",
        endAt: "2026-06-15T03:30:00.000Z",
        attendees: [{}],
      }),
    ).rejects.toThrow()
  })

  test("get returns the event with attendees, list paginates", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const found = await expectAllowed(() => service.get(ctx, created.id))
    expect(found.event.id).toBe(created.id)
    expect(found.attendees).toEqual([])
    const listed = await expectAllowed(() => service.list(ctx, { limit: 25 }))
    expect(listed.data).toHaveLength(1)
    expect(listed.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("list supports a date-range query (from/to overlap)", async () => {
    const clock = freezeTime("2026-06-01T00:00:00.000Z")
    try {
      const { ctx, service } = setup()
      const inRange = await seed(service, ctx, {
        title: "June event",
        startAt: "2026-06-15T02:30:00.000Z",
        endAt: "2026-06-15T03:30:00.000Z",
      })
      await seed(service, ctx, {
        title: "July event",
        startAt: "2026-07-15T02:30:00.000Z",
        endAt: "2026-07-15T03:30:00.000Z",
      })
      const listed = await expectAllowed(() =>
        service.list(ctx, { from: "2026-06-01T00:00:00.000Z", to: "2026-06-30T23:59:59.000Z" }),
      )
      expect(listed.data.map((e) => e.id)).toEqual([inRange.id])
    } finally {
      clock.restore()
    }
  })

  test("get throws NOT_FOUND for unknown ids", async () => {
    const { ctx, service } = setup()
    const err = await service.get(ctx, "missing").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe("NOT_FOUND")
  })

  test("update emits calendar.event_updated and audits with before/after", async () => {
    const { ctx, service, audits } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      const updated = await expectAllowed(() =>
        service.update(ctx, created.id, { location: "Room 4" }),
      )
      expect(updated.location).toBe("Room 4")
      const emitted = events.expectEmitted("calendar.event_updated", { entityId: created.id })
      expect(emitted.before).toMatchObject({ location: null })
      expect(emitted.after).toMatchObject({ location: "Room 4" })
      expect(audits.at(-1)).toMatchObject({ action: "update", recordId: created.id })
    } finally {
      events.release()
    }
  })

  test("softDelete emits calendar.event_deleted and hides the row; restore revives it", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      await expectAllowed(() => service.softDelete(ctx, created.id))
      events.expectEmitted("calendar.event_deleted", { entityId: created.id })
      await expect(service.get(ctx, created.id)).rejects.toMatchObject({ code: "NOT_FOUND" })
      const restored = await expectAllowed(() => service.restore(ctx, created.id))
      expect(restored.id).toBe(created.id)
      await expectAllowed(() => service.get(ctx, created.id))
    } finally {
      events.release()
    }
  })

  // The classic calendar bug: prove the round trip end to end — the store
  // holds a plain UTC ISO string (as `timestamptz` does), and the workspace
  // timezone (here a non-UTC one) renders it onto the correct local day/hour.
  test("a UTC-stored event renders correctly for a non-UTC workspace timezone", async () => {
    const { ctx, service } = setup("owner", makeStore("America/New_York"))
    const created = await seed(service, ctx, {
      title: "Late UTC event",
      startAt: "2026-06-15T02:30:00.000Z",
      endAt: "2026-06-15T03:30:00.000Z",
    })
    const timezone = await expectAllowed(() => service.getWorkspaceTimezone(ctx))
    expect(timezone).toBe("America/New_York")
    expect(formatEventDateTime(created.startAt as string, timezone)).toBe("2026-06-14 22:30")
  })

  describe("denials", () => {
    let backing: ReturnType<typeof makeStore>
    let workspaceId: string
    let eventId: string

    function asRole(role: "owner" | "admin" | "member" | "viewer") {
      return setup(role, backing, workspaceId)
    }

    beforeEach(async () => {
      backing = makeStore()
      const owner = setup("owner", backing)
      workspaceId = owner.ctx.workspaceId
      eventId = (await seed(owner.service, owner.ctx)).id
    })

    test("viewer cannot create", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => seed(service, ctx))
    })

    test("viewer cannot update", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.update(ctx, eventId, { location: "X" }))
    })

    test("member cannot delete (admin-only)", async () => {
      const { ctx, service } = asRole("member")
      await expectDenied(() => service.softDelete(ctx, eventId))
    })

    test("viewer can still list and get (read is open)", async () => {
      const { ctx, service } = asRole("viewer")
      await expectAllowed(() => service.list(ctx, {}))
      await expectAllowed(() => service.get(ctx, eventId))
    })
  })
})
