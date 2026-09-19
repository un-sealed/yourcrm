import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import postgres from "postgres"
import type { Database } from "../client"
import type { Booking, BookingLink } from "../schema/booking-links"
import {
  BookingSlotTakenError,
  createBookingLinksRepository,
  normalizeSlug,
  normalizeTitle,
  validateInviteeEmail,
} from "./booking-links-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const OWNER = "22222222-2222-4222-8222-222222222222"
const LINK_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const MIGRATION = new URL("../../migrations/0280_booking_links.sql", import.meta.url)

/**
 * Thenable chain stub: every query builder call returns the proxy; each
 * await pops one queued result. Same hermetic pattern as
 * `calendar-repository.test.ts` — `docs/conventions.md` forbids a live
 * Postgres in unit tests, so the DB-level double-booking guarantee is proven
 * two ways here instead: (1) the migration text assertion below shows the
 * partial unique index exists, and (2) `createBooking rejects a concurrent
 * duplicate slot` proves the repository translates the real driver's
 * unique-violation error (Postgres SQLSTATE 23505, thrown by the second of
 * two racing inserts once the *database* enforces the constraint) into a
 * typed `BookingSlotTakenError` instead of the naive check-then-insert being
 * the only protection against a lost race.
 */
function mockDb(queued: unknown[][] = []): Database {
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

/** Same shape, but every chain rejects with `err` instead of resolving. */
function mockDbRejecting(err: unknown): Database {
  const proxy = new Proxy(function () {}, {
    get(_target, prop: string | symbol) {
      if (prop === "then") {
        return (_resolve: (value: unknown) => void, reject: (err: unknown) => void) => {
          reject(err)
        }
      }
      return (..._args: unknown[]) => proxy
    },
  })
  return proxy as unknown as Database
}

function makePostgresUniqueViolation(): postgres.PostgresError {
  const err = Object.create(postgres.PostgresError.prototype) as postgres.PostgresError
  Object.assign(err, {
    name: "PostgresError",
    message: 'duplicate key value violates unique constraint "bookings_link_start_uidx"',
    code: "23505",
    constraint_name: "bookings_link_start_uidx",
  })
  return err
}

function makeLink(overrides: Partial<BookingLink> = {}): BookingLink {
  return {
    id: LINK_ID,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    ownerId: OWNER,
    slug: "ada-30min",
    title: "30 minute chat",
    description: null,
    durationMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeMinutes: 60,
    maxDaysAhead: 30,
    location: null,
    status: "active",
    ...overrides,
  }
}

function makeBooking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    workspaceId: WS,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    bookingLinkId: LINK_ID,
    startsAt: new Date("2026-06-15T14:00:00.000Z"),
    endsAt: new Date("2026-06-15T14:30:00.000Z"),
    inviteeName: "Grace Hopper",
    inviteeEmail: "grace@example.com",
    inviteeTimezone: "America/New_York",
    status: "confirmed",
    calendarEventId: null,
    notes: null,
    cancellationReason: null,
    ...overrides,
  }
}

describe("booking-links/validation", () => {
  test("titles trim and collapse whitespace", () => {
    expect(normalizeTitle("  30  minute   chat  ")).toBe("30 minute chat")
  })

  test("titles reject empty values", () => {
    expect(() => normalizeTitle("   ")).toThrow(/must not be empty/)
  })

  test("slugs lowercase and trim", () => {
    expect(normalizeSlug("  Ada-30Min  ")).toBe("ada-30min")
  })

  test("slugs reject spaces and punctuation", () => {
    expect(() => normalizeSlug("Not A Slug!")).toThrow(/lowercase/)
  })

  test("invitee emails lowercase and validate shape", () => {
    expect(validateInviteeEmail(" Grace@Example.com ")).toBe("grace@example.com")
    expect(() => validateInviteeEmail("not-an-email")).toThrow(/valid address/)
  })
})

describe("booking-links/repository", () => {
  test("create returns the inserted row", async () => {
    const repo = createBookingLinksRepository()
    const link = makeLink()
    const row = await repo.create(mockDb([[link]]), WS, {
      ownerId: OWNER,
      slug: "ada-30min",
      title: "30 minute chat",
      durationMinutes: 30,
    })
    expect(row).toEqual(link)
  })

  test("create rejects an invalid slug before touching the db", async () => {
    const repo = createBookingLinksRepository()
    await expect(
      repo.create(mockDb([]), WS, {
        ownerId: OWNER,
        slug: "Not A Slug!",
        title: "30 minute chat",
        durationMinutes: 30,
      }),
    ).rejects.toThrow(/lowercase/)
  })

  test("create surfaces empty insert results as errors", async () => {
    const repo = createBookingLinksRepository()
    await expect(
      repo.create(mockDb([[]]), WS, {
        ownerId: OWNER,
        slug: "ada-30min",
        title: "30 minute chat",
        durationMinutes: 30,
      }),
    ).rejects.toThrow(/insert returned no rows/)
  })

  test("search returns the cursor pagination envelope", async () => {
    const repo = createBookingLinksRepository()
    const result = await repo.search(mockDb([[makeLink()]]), { workspaceId: WS })
    expect(result.data).toHaveLength(1)
    expect(result.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("update returns null when the row is missing", async () => {
    const repo = createBookingLinksRepository()
    const row = await repo.update(mockDb([[]]), WS, LINK_ID, { title: "New title" })
    expect(row).toBeNull()
  })

  test("findWithRules returns null when the link is missing", async () => {
    const repo = createBookingLinksRepository()
    const found = await repo.findWithRules(mockDb([[]]), WS, LINK_ID)
    expect(found).toBeNull()
  })

  test("findWithRules returns the link plus its rules", async () => {
    const repo = createBookingLinksRepository()
    const link = makeLink()
    const rule = {
      id: "rule-1",
      workspaceId: WS,
      bookingLinkId: LINK_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: null,
      updatedBy: null,
      deletedAt: null,
      dayOfWeek: 1,
      startMinute: 540,
      endMinute: 1020,
    }
    const found = await repo.findWithRules(mockDb([[link], [rule]]), WS, LINK_ID)
    expect(found?.bookingLink).toEqual(link)
    expect(found?.rules).toEqual([rule])
  })

  test("findActiveBySlug returns null when no active link matches", async () => {
    const repo = createBookingLinksRepository()
    const found = await repo.findActiveBySlug(mockDb([[]]), "missing-slug")
    expect(found).toBeNull()
  })

  test("getWorkspaceTimezone returns the stored timezone, defaulting to UTC", async () => {
    const repo = createBookingLinksRepository()
    const withTz = await repo.getWorkspaceTimezone(mockDb([[{ timezone: "America/New_York" }]]), WS)
    expect(withTz).toBe("America/New_York")
    const withoutRow = await repo.getWorkspaceTimezone(mockDb([[]]), WS)
    expect(withoutRow).toBe("UTC")
  })

  test("createBooking returns the inserted row on success", async () => {
    const repo = createBookingLinksRepository()
    const booking = makeBooking()
    const row = await repo.createBooking(mockDb([[booking]]), WS, LINK_ID, {
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      inviteeName: booking.inviteeName,
      inviteeEmail: booking.inviteeEmail,
      inviteeTimezone: booking.inviteeTimezone,
    })
    expect(row).toEqual(booking)
  })

  test("createBooking rejects a concurrent duplicate slot with BookingSlotTakenError", async () => {
    // Models the losing side of a real race: two invitees submit the same
    // slot at once, the database's partial unique index
    // (bookings_link_start_uidx) lets exactly one confirmed row through, and
    // the loser's insert fails with Postgres 23505 (unique_violation). This
    // is the property the double-booking guard depends on — the repository
    // must surface it as a typed, catchable domain error rather than an
    // unhandled driver exception.
    const repo = createBookingLinksRepository()
    const startsAt = new Date("2026-06-15T14:00:00.000Z")
    const endsAt = new Date("2026-06-15T14:30:00.000Z")
    const db = mockDbRejecting(makePostgresUniqueViolation())
    const err = await repo
      .createBooking(db, WS, LINK_ID, {
        startsAt,
        endsAt,
        inviteeName: "Second Invitee",
        inviteeEmail: "second@example.com",
        inviteeTimezone: "UTC",
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BookingSlotTakenError)
    expect((err as BookingSlotTakenError).code).toBe("BOOKING_SLOT_TAKEN")
    expect((err as Error).message).toContain(startsAt.toISOString())
  })

  test("createBooking rejects endsAt before startsAt before touching the db", async () => {
    const repo = createBookingLinksRepository()
    await expect(
      repo.createBooking(mockDb([]), WS, LINK_ID, {
        startsAt: "2026-06-15T14:30:00.000Z",
        endsAt: "2026-06-15T14:00:00.000Z",
        inviteeName: "Ada",
        inviteeEmail: "ada@example.com",
        inviteeTimezone: "UTC",
      }),
    ).rejects.toThrow(/must not be before/)
  })

  test("createBooking propagates unrelated driver errors untouched", async () => {
    const repo = createBookingLinksRepository()
    const boom = new Error("connection reset")
    const db = mockDbRejecting(boom)
    const err = await repo
      .createBooking(db, WS, LINK_ID, {
        startsAt: new Date("2026-06-15T14:00:00.000Z"),
        endsAt: new Date("2026-06-15T14:30:00.000Z"),
        inviteeName: "Ada",
        inviteeEmail: "ada@example.com",
        inviteeTimezone: "UTC",
      })
      .catch((e: unknown) => e)
    expect(err).toBe(boom)
  })

  test("listActiveBookingsInRange returns start/end pairs only (no invitee PII)", async () => {
    const repo = createBookingLinksRepository()
    const rows = await repo.listActiveBookingsInRange(
      mockDb([
        [{ startsAt: new Date("2026-06-15T14:00:00Z"), endsAt: new Date("2026-06-15T14:30:00Z") }],
      ]),
      LINK_ID,
      new Date("2026-06-15T00:00:00Z"),
      new Date("2026-06-16T00:00:00Z"),
    )
    expect(rows).toEqual([
      { startsAt: new Date("2026-06-15T14:00:00Z"), endsAt: new Date("2026-06-15T14:30:00Z") },
    ])
  })

  test("cancelBooking updates status and reason", async () => {
    const repo = createBookingLinksRepository()
    const cancelled = makeBooking({ status: "cancelled", cancellationReason: "invitee request" })
    const row = await repo.cancelBooking(mockDb([[cancelled]]), WS, cancelled.id, "invitee request")
    expect(row?.status).toBe("cancelled")
    expect(row?.cancellationReason).toBe("invitee request")
  })
})

describe("booking-links/migration", () => {
  test("0280 creates booking_links, booking_availability_rules and bookings", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS booking_links")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS booking_availability_rules")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS bookings")
    expect(sql).toContain("REFERENCES booking_links (id) ON DELETE CASCADE")
  })

  test("the double-booking guard is a partial unique index, not just app logic", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS bookings_link_start_uidx\n  ON bookings (booking_link_id, starts_at) WHERE status = 'confirmed';",
    )
  })

  test("slug is globally unique (workspace-agnostic public routing)", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("booking_links_slug_uidx ON booking_links (lower(slug))")
  })

  test("cross-module references stay FK-free", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const linksBlock = sql.slice(
      sql.indexOf("CREATE TABLE IF NOT EXISTS booking_links"),
      sql.indexOf("CREATE TABLE IF NOT EXISTS booking_availability_rules"),
    )
    expect(linksBlock).toContain("owner_id UUID NOT NULL")
    expect(linksBlock).not.toContain("REFERENCES users")
    const bookingsBlock = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS bookings"))
    expect(bookingsBlock).toContain("calendar_event_id UUID")
    expect(bookingsBlock).not.toContain("REFERENCES calendar_events")
  })
})
