import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import {
  calendarEventAttendees,
  calendarEvents,
  type CalendarEvent,
  type CalendarEventAttendee,
} from "../schema/calendar"
import {
  createCalendarRepository,
  normalizeEventTitle,
  validateAttendeeEmail,
} from "./calendar-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const EVENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const MIGRATION = new URL("../../migrations/0150_calendar.sql", import.meta.url)

/** Thenable chain stub: every query builder call returns the proxy; each await pops one result. */
function mockDb(queued: unknown[][] = []) {
  let step = 0
  const proxy = new Proxy(function () {}, {
    get(_target, prop: string | symbol) {
      if (prop === "then") {
        return (resolve: (value: unknown) => void) => {
          resolve(queued[step] ?? [])
          step += 1
        }
      }
      return (..._args: unknown[]) => proxy
    },
  })
  return proxy as unknown as Database
}

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: EVENT_ID,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    ownerId: null,
    title: "Kickoff",
    description: null,
    location: null,
    startAt: new Date("2026-06-15T02:30:00.000Z"),
    endAt: new Date("2026-06-15T03:30:00.000Z"),
    allDay: false,
    status: "confirmed",
    personId: null,
    companyId: null,
    dealId: null,
    ...overrides,
  }
}

function makeAttendee(overrides: Partial<CalendarEventAttendee> = {}): CalendarEventAttendee {
  return {
    id: "a1",
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    eventId: EVENT_ID,
    userId: "u1",
    email: null,
    name: null,
    responseStatus: "needs_action",
    isOrganizer: false,
    ...overrides,
  }
}

describe("calendar/schema", () => {
  test("calendar_events expose the BaseRecord column contract", () => {
    const cols = calendarEvents as unknown as Record<string, unknown>
    for (const col of ["id", "workspaceId", "createdAt", "updatedAt", "deletedAt"]) {
      expect(cols[col], col).toBeDefined()
    }
    expect(cols.startAt).toBeDefined()
    expect(cols.endAt).toBeDefined()
    expect(cols.allDay).toBeDefined()
    expect(cols.personId).toBeDefined()
    expect(cols.companyId).toBeDefined()
    expect(cols.dealId).toBeDefined()
  })

  test("calendar_event_attendees carry an event FK plus workspace scoping", () => {
    const cols = calendarEventAttendees as unknown as Record<string, unknown>
    expect(cols.eventId).toBeDefined()
    expect(cols.workspaceId).toBeDefined()
    expect(cols.userId).toBeDefined()
    expect(cols.email).toBeDefined()
  })
})

describe("calendar/validation", () => {
  test("titles trim and collapse whitespace", () => {
    expect(normalizeEventTitle("  Kickoff   call ")).toBe("Kickoff call")
  })

  test("titles reject empty and overlong values", () => {
    expect(() => normalizeEventTitle("   ")).toThrow()
    expect(() => normalizeEventTitle("x".repeat(256))).toThrow()
  })

  test("attendee emails lowercase and validate shape", () => {
    expect(validateAttendeeEmail("Ext@Example.COM ")).toBe("ext@example.com")
    expect(() => validateAttendeeEmail("not-an-email")).toThrow()
  })
})

describe("calendar/repository", () => {
  test("create returns the inserted row", async () => {
    const repo = createCalendarRepository()
    const row = makeEvent()
    const result = await repo.create(mockDb([[row]]), WS, {
      title: "Kickoff",
      startAt: "2026-06-15T02:30:00.000Z",
      endAt: "2026-06-15T03:30:00.000Z",
    })
    expect(result).toBe(row)
  })

  test("create rejects empty titles before touching the db", async () => {
    const repo = createCalendarRepository()
    await expect(
      repo.create(mockDb(), WS, {
        title: "  ",
        startAt: "2026-06-15T02:30:00.000Z",
        endAt: "2026-06-15T03:30:00.000Z",
      }),
    ).rejects.toThrow()
  })

  test("create rejects endAt before startAt before touching the db", async () => {
    const repo = createCalendarRepository()
    await expect(
      repo.create(mockDb(), WS, {
        title: "Backwards",
        startAt: "2026-06-15T03:30:00.000Z",
        endAt: "2026-06-15T02:30:00.000Z",
      }),
    ).rejects.toThrow(/endAt/)
  })

  test("create surfaces empty insert results as errors", async () => {
    const repo = createCalendarRepository()
    await expect(
      repo.create(mockDb([[]]), WS, {
        title: "Kickoff",
        startAt: "2026-06-15T02:30:00.000Z",
        endAt: "2026-06-15T03:30:00.000Z",
      }),
    ).rejects.toThrow()
  })

  test("create rejects unknown status values", async () => {
    const repo = createCalendarRepository()
    await expect(
      repo.create(mockDb(), WS, {
        title: "Kickoff",
        startAt: "2026-06-15T02:30:00.000Z",
        endAt: "2026-06-15T03:30:00.000Z",
        status: "tentative",
      }),
    ).rejects.toThrow(/status/)
  })

  test("create rejects an attendee with both userId and email", async () => {
    const repo = createCalendarRepository()
    const row = makeEvent()
    await expect(
      repo.create(mockDb([[row]]), WS, {
        title: "Kickoff",
        startAt: "2026-06-15T02:30:00.000Z",
        endAt: "2026-06-15T03:30:00.000Z",
        attendees: [{ userId: "u1", email: "both@example.com" }],
      }),
    ).rejects.toThrow(/exactly one/)
  })

  test("create rejects an attendee with neither userId nor email", async () => {
    const repo = createCalendarRepository()
    const row = makeEvent()
    await expect(
      repo.create(mockDb([[row]]), WS, {
        title: "Kickoff",
        startAt: "2026-06-15T02:30:00.000Z",
        endAt: "2026-06-15T03:30:00.000Z",
        attendees: [{}],
      }),
    ).rejects.toThrow(/exactly one/)
  })

  test("search returns the cursor pagination envelope", async () => {
    const repo = createCalendarRepository()
    const rows = [makeEvent({ id: "id-1" }), makeEvent({ id: "id-2" }), makeEvent({ id: "id-3" })]
    const result = await repo.search(mockDb([rows]), { workspaceId: WS, limit: 2, query: "kick" })
    expect(result.data).toHaveLength(2)
    expect(result.pagination).toEqual({ nextCursor: "id-2", limit: 2 })
  })

  test("search accepts a date-range (from/to)", async () => {
    const repo = createCalendarRepository()
    const rows = [makeEvent()]
    const result = await repo.search(mockDb([rows]), {
      workspaceId: WS,
      from: "2026-06-01T00:00:00.000Z",
      to: "2026-06-30T23:59:59.000Z",
    })
    expect(result.data).toHaveLength(1)
  })

  test("update returns null when the row is missing", async () => {
    const repo = createCalendarRepository()
    await expect(
      repo.update(mockDb([[]]), WS, "missing", { location: "Room 4" }),
    ).resolves.toBeNull()
  })

  test("update rejects endAt before startAt before touching the db", async () => {
    const repo = createCalendarRepository()
    await expect(
      repo.update(mockDb(), WS, EVENT_ID, {
        startAt: "2026-06-15T03:30:00.000Z",
        endAt: "2026-06-15T02:30:00.000Z",
      }),
    ).rejects.toThrow(/endAt/)
  })

  test("findWithAttendees returns null when the event is missing", async () => {
    const repo = createCalendarRepository()
    await expect(repo.findWithAttendees(mockDb([[]]), WS, "missing")).resolves.toBeNull()
  })

  test("findWithAttendees returns the event plus attendee rows", async () => {
    const repo = createCalendarRepository()
    const row = makeEvent()
    const attendees = [makeAttendee()]
    const result = await repo.findWithAttendees(mockDb([[row], attendees]), WS, EVENT_ID)
    expect(result?.event).toBe(row)
    expect(result?.attendees).toBe(attendees)
  })

  test("getWorkspaceTimezone returns the stored timezone, defaulting to UTC", async () => {
    const repo = createCalendarRepository()
    const withTz = await repo.getWorkspaceTimezone(mockDb([[{ timezone: "America/New_York" }]]), WS)
    expect(withTz).toBe("America/New_York")
    const withoutRow = await repo.getWorkspaceTimezone(mockDb([[]]), WS)
    expect(withoutRow).toBe("UTC")
  })
})

describe("calendar/migration", () => {
  test("0150 creates calendar_events plus attendees with the agreed indexes", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS calendar_events")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS calendar_event_attendees")
    expect(sql).toContain("calendar_events_range_idx")
    expect(sql).toContain("calendar_event_attendees_user_uidx")
    expect(sql).toContain("calendar_event_attendees_email_uidx")
    expect(sql).toContain("REFERENCES calendar_events (id) ON DELETE CASCADE")
    expect(sql).toContain("start_at TIMESTAMPTZ NOT NULL")
    expect(sql).toContain("end_at TIMESTAMPTZ NOT NULL")
  })

  test("cross-module references stay FK-free", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const block = sql.slice(
      sql.indexOf("CREATE TABLE IF NOT EXISTS calendar_events"),
      sql.indexOf("CREATE TABLE IF NOT EXISTS calendar_event_attendees"),
    )
    expect(block).toContain("person_id UUID")
    expect(block).toContain("company_id UUID")
    expect(block).toContain("deal_id UUID")
    expect(block).not.toContain("REFERENCES people")
    expect(block).not.toContain("REFERENCES companies")
    expect(block).not.toContain("REFERENCES deals")
    const attendeesBlock = sql.slice(
      sql.indexOf("CREATE TABLE IF NOT EXISTS calendar_event_attendees"),
    )
    expect(attendeesBlock).toContain("user_id UUID")
    expect(attendeesBlock).not.toContain("REFERENCES users")
  })
})
