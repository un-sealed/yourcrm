import { and, eq, gte, ilike, isNull, lte, or, type SQL } from "drizzle-orm"
import postgres from "postgres"
import type { Database } from "../client"
import { workspaces } from "../schema/core"
import {
  bookingAvailabilityRules,
  bookingLinks,
  bookings,
  isBookingLinkStatus,
  isBookingStatus,
  type Booking,
  type BookingAvailabilityRule,
  type BookingLink,
  type NewBooking,
  type NewBookingAvailabilityRule,
  type NewBookingLink,
} from "../schema/booking-links"
import { createBaseRepository } from "./base-repository"

/**
 * Booking Links repository (spec 48-booking-links, P0) — mirrors the
 * calendar repository's shape (`calendar-repository.ts`): workspace-scoped
 * CRUD over `createBaseRepository`, plus the module-specific reads/writes
 * the domain service needs.
 */

export class BookingSlotTakenError extends Error {
  readonly code = "BOOKING_SLOT_TAKEN"
  constructor(startsAt: Date) {
    super(`booking.create: the slot starting at ${startsAt.toISOString()} was just taken`)
    this.name = "BookingSlotTakenError"
  }
}

/** Postgres SQLSTATE 23505 = unique_violation. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof postgres.PostgresError && err.code === "23505"
}

export type CreateBookingLinkInput = {
  ownerId: string
  slug: string
  title: string
  description?: string | null
  durationMinutes: number
  bufferBeforeMinutes?: number | null
  bufferAfterMinutes?: number | null
  minNoticeMinutes?: number | null
  maxDaysAhead?: number | null
  location?: string | null
  status?: string | null
  rules?: AvailabilityRuleInput[]
}

export type UpdateBookingLinkInput = Partial<
  Pick<
    NewBookingLink,
    | "ownerId"
    | "title"
    | "description"
    | "durationMinutes"
    | "bufferBeforeMinutes"
    | "bufferAfterMinutes"
    | "minNoticeMinutes"
    | "maxDaysAhead"
    | "location"
  >
> & {
  slug?: string
  status?: string | null
}

export type AvailabilityRuleInput = {
  dayOfWeek: number
  startMinute: number
  endMinute: number
}

export type BookingLinkWithRules = {
  bookingLink: BookingLink
  rules: BookingAvailabilityRule[]
}

export type CreateBookingInput = {
  startsAt: Date | string
  endsAt: Date | string
  inviteeName: string
  inviteeEmail: string
  inviteeTimezone: string
  notes?: string | null
}

/** Trimmed, non-empty title (max 255, mirrors the column). */
export function normalizeTitle(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new Error("booking-links.create: title must not be empty")
  if (trimmed.length > 255)
    throw new Error("booking-links.create: title must be at most 255 characters")
  return trimmed
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Lowercase, hyphen-separated slug (mirrors the DB check + unique index). */
export function normalizeSlug(value: string): string {
  const trimmed = value.trim().toLowerCase()
  if (!SLUG_RE.test(trimmed)) {
    throw new Error("booking-links.create: slug must be lowercase alphanumeric, hyphen-separated")
  }
  if (trimmed.length > 160)
    throw new Error("booking-links.create: slug must be at most 160 characters")
  return trimmed
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validateInviteeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase()
  if (!EMAIL_RE.test(trimmed))
    throw new Error("booking-links.book: inviteeEmail must be a valid address")
  if (trimmed.length > 320)
    throw new Error("booking-links.book: inviteeEmail must be at most 320 characters")
  return trimmed
}

function toDate(value: Date | string, field: string): Date {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`booking-links: ${field} must be a valid date`)
  return date
}

function toLinkValues(
  workspaceId: string,
  input: CreateBookingLinkInput | UpdateBookingLinkInput,
  actorId?: string,
): Partial<NewBookingLink> {
  const values: Partial<NewBookingLink> = {}
  if (input.title !== undefined) values.title = normalizeTitle(input.title)
  if ("slug" in input && input.slug !== undefined) values.slug = normalizeSlug(input.slug)
  if (input.description !== undefined) values.description = input.description ?? null
  if (input.ownerId !== undefined) values.ownerId = input.ownerId
  if (input.durationMinutes !== undefined) values.durationMinutes = input.durationMinutes
  if (input.bufferBeforeMinutes !== undefined)
    values.bufferBeforeMinutes = input.bufferBeforeMinutes ?? 0
  if (input.bufferAfterMinutes !== undefined)
    values.bufferAfterMinutes = input.bufferAfterMinutes ?? 0
  if (input.minNoticeMinutes !== undefined) values.minNoticeMinutes = input.minNoticeMinutes ?? 60
  if (input.maxDaysAhead !== undefined) values.maxDaysAhead = input.maxDaysAhead ?? 30
  if (input.location !== undefined) values.location = input.location?.trim() || null
  if (input.status !== undefined) {
    if (input.status !== null && !isBookingLinkStatus(input.status)) {
      throw new Error("booking-links: status must be one of active, archived")
    }
    values.status = input.status ?? "active"
  }
  if (actorId !== undefined) values.updatedBy = actorId
  return { ...values, workspaceId }
}

export function createBookingLinksRepository() {
  const base = createBaseRepository(bookingLinks)
  const bookingsBase = createBaseRepository(bookings)

  async function insertRules(
    db: Database,
    workspaceId: string,
    bookingLinkId: string,
    rules: AvailabilityRuleInput[],
    actorId?: string,
  ): Promise<BookingAvailabilityRule[]> {
    const out: BookingAvailabilityRule[] = []
    for (const rule of rules) {
      if (!Number.isInteger(rule.dayOfWeek) || rule.dayOfWeek < 0 || rule.dayOfWeek > 6) {
        throw new Error("booking-links.rules: dayOfWeek must be an integer 0-6")
      }
      if (
        !Number.isInteger(rule.startMinute) ||
        !Number.isInteger(rule.endMinute) ||
        rule.startMinute < 0 ||
        rule.endMinute <= rule.startMinute ||
        rule.endMinute > 1440
      ) {
        throw new Error("booking-links.rules: startMinute/endMinute out of range")
      }
      const values: NewBookingAvailabilityRule = {
        workspaceId,
        bookingLinkId,
        dayOfWeek: rule.dayOfWeek,
        startMinute: rule.startMinute,
        endMinute: rule.endMinute,
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      }
      const rows = await db.insert(bookingAvailabilityRules).values(values).returning()
      const row = rows[0]
      if (row) out.push(row)
    }
    return out
  }

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateBookingLinkInput,
      actorId?: string,
    ): Promise<BookingLink> {
      const rows = await db
        .insert(bookingLinks)
        .values({
          ...toLinkValues(workspaceId, input, actorId),
          workspaceId,
          ownerId: input.ownerId,
          title: normalizeTitle(input.title),
          slug: normalizeSlug(input.slug),
          durationMinutes: input.durationMinutes,
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("booking-links.create: insert returned no rows")
      await insertRules(db, workspaceId, row.id, input.rules ?? [], actorId)
      return row
    },

    /** Cursor-paginated list with search (title/slug) and status filter. */
    async search(
      db: Database,
      opts: { workspaceId: string; limit?: number; cursor?: string; order?: "asc" | "desc" } & {
        query?: string
        status?: string
      },
    ) {
      const conditions: SQL[] = []
      if (opts.query) {
        const q = `%${opts.query.trim()}%`
        const textMatch = or(ilike(bookingLinks.title, q), ilike(bookingLinks.slug, q))
        if (textMatch) conditions.push(textMatch)
      }
      if (opts.status) {
        if (!isBookingLinkStatus(opts.status))
          throw new Error("booking-links.search: unknown status filter")
        conditions.push(eq(bookingLinks.status, opts.status))
      }
      const result = await base.list(db, { ...opts, where: conditions })
      return { data: result.data as BookingLink[], pagination: result.pagination }
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateBookingLinkInput,
      actorId?: string,
    ): Promise<BookingLink | null> {
      const rows = await db
        .update(bookingLinks)
        .set({ ...toLinkValues(workspaceId, input, actorId), updatedAt: new Date() })
        .where(
          and(
            eq(bookingLinks.id, id),
            eq(bookingLinks.workspaceId, workspaceId),
            isNull(bookingLinks.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    async findById(db: Database, workspaceId: string, id: string): Promise<BookingLink | null> {
      const row = await base.findById(db, workspaceId, id)
      return (row as BookingLink | null) ?? null
    },

    async findWithRules(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<BookingLinkWithRules | null> {
      const bookingLink = await this.findById(db, workspaceId, id)
      if (!bookingLink) return null
      const rules = await db
        .select()
        .from(bookingAvailabilityRules)
        .where(
          and(
            eq(bookingAvailabilityRules.bookingLinkId, id),
            eq(bookingAvailabilityRules.workspaceId, workspaceId),
            isNull(bookingAvailabilityRules.deletedAt),
          ),
        )
      return { bookingLink, rules }
    },

    /** Public lookup by slug — active links only, no workspace scope required. */
    async findActiveBySlug(db: Database, slug: string): Promise<BookingLinkWithRules | null> {
      const rows = await db
        .select()
        .from(bookingLinks)
        .where(
          and(
            eq(bookingLinks.slug, slug.trim().toLowerCase()),
            eq(bookingLinks.status, "active"),
            isNull(bookingLinks.deletedAt),
          ),
        )
        .limit(1)
      const bookingLink = rows[0]
      if (!bookingLink) return null
      const rules = await db
        .select()
        .from(bookingAvailabilityRules)
        .where(
          and(
            eq(bookingAvailabilityRules.bookingLinkId, bookingLink.id),
            isNull(bookingAvailabilityRules.deletedAt),
          ),
        )
      return { bookingLink, rules }
    },

    /** Replace every availability rule (delete + reinsert, mirrors calendar attendee replace). */
    async replaceRules(
      db: Database,
      workspaceId: string,
      bookingLinkId: string,
      rules: AvailabilityRuleInput[],
      actorId?: string,
    ): Promise<BookingAvailabilityRule[]> {
      await db
        .delete(bookingAvailabilityRules)
        .where(
          and(
            eq(bookingAvailabilityRules.bookingLinkId, bookingLinkId),
            eq(bookingAvailabilityRules.workspaceId, workspaceId),
          ),
        )
      return insertRules(db, workspaceId, bookingLinkId, rules, actorId)
    },

    /** `workspaces.timezone` (IANA name). Defaults to `"UTC"` when the workspace row is missing. */
    async getWorkspaceTimezone(db: Database, workspaceId: string): Promise<string> {
      const rows = await db
        .select({ timezone: workspaces.timezone })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1)
      return rows[0]?.timezone ?? "UTC"
    },

    /** Admin (authenticated) cursor list of bookings under one link. */
    async listBookings(
      db: Database,
      opts: {
        workspaceId: string
        bookingLinkId: string
        limit?: number
        cursor?: string
        order?: "asc" | "desc"
        status?: string
      },
    ) {
      const conditions: SQL[] = [eq(bookings.bookingLinkId, opts.bookingLinkId)]
      if (opts.status) {
        if (!isBookingStatus(opts.status))
          throw new Error("booking-links.listBookings: unknown status filter")
        conditions.push(eq(bookings.status, opts.status))
      }
      const result = await bookingsBase.list(db, { ...opts, where: conditions })
      return { data: result.data as Booking[], pagination: result.pagination }
    },

    /** Busy intervals (start/end only — no invitee PII) for a link in a UTC range. */
    async listActiveBookingsInRange(
      db: Database,
      bookingLinkId: string,
      fromUtc: Date,
      toUtc: Date,
    ): Promise<{ startsAt: Date; endsAt: Date }[]> {
      const rows = await db
        .select({ startsAt: bookings.startsAt, endsAt: bookings.endsAt })
        .from(bookings)
        .where(
          and(
            eq(bookings.bookingLinkId, bookingLinkId),
            eq(bookings.status, "confirmed"),
            isNull(bookings.deletedAt),
            gte(bookings.endsAt, fromUtc),
            lte(bookings.startsAt, toUtc),
          ),
        )
      return rows
    },

    /**
     * Insert a confirmed booking. The database's partial unique index
     * (`bookings_link_start_uidx`) is the actual double-booking guard: a
     * concurrent insert for the same `(bookingLinkId, startsAt)` fails with
     * Postgres 23505, translated here into `BookingSlotTakenError` instead
     * of leaking a raw driver error to the domain service.
     */
    async createBooking(
      db: Database,
      workspaceId: string,
      bookingLinkId: string,
      input: CreateBookingInput,
    ): Promise<Booking> {
      const startsAt = toDate(input.startsAt, "startsAt")
      const endsAt = toDate(input.endsAt, "endsAt")
      if (endsAt.getTime() < startsAt.getTime()) {
        throw new Error("booking-links.book: endsAt must not be before startsAt")
      }
      const values: NewBooking = {
        workspaceId,
        bookingLinkId,
        startsAt,
        endsAt,
        inviteeName: input.inviteeName.trim(),
        inviteeEmail: validateInviteeEmail(input.inviteeEmail),
        inviteeTimezone: input.inviteeTimezone,
        status: "confirmed",
        notes: input.notes?.trim() || null,
      }
      try {
        const rows = await db.insert(bookings).values(values).returning()
        const row = rows[0]
        if (!row) throw new Error("booking-links.book: insert returned no rows")
        return row
      } catch (err) {
        if (isUniqueViolation(err)) throw new BookingSlotTakenError(startsAt)
        throw err
      }
    },

    async findBookingById(db: Database, workspaceId: string, id: string): Promise<Booking | null> {
      const rows = await db
        .select()
        .from(bookings)
        .where(
          and(
            eq(bookings.id, id),
            eq(bookings.workspaceId, workspaceId),
            isNull(bookings.deletedAt),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },

    async cancelBooking(
      db: Database,
      workspaceId: string,
      id: string,
      reason?: string | null,
      actorId?: string,
    ): Promise<Booking | null> {
      const rows = await db
        .update(bookings)
        .set({
          status: "cancelled",
          cancellationReason: reason ?? null,
          updatedAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(and(eq(bookings.id, id), eq(bookings.workspaceId, workspaceId)))
        .returning()
      return rows[0] ?? null
    },

    async attachCalendarEvent(
      db: Database,
      workspaceId: string,
      bookingId: string,
      calendarEventId: string,
    ): Promise<void> {
      await db
        .update(bookings)
        .set({ calendarEventId, updatedAt: new Date() })
        .where(and(eq(bookings.id, bookingId), eq(bookings.workspaceId, workspaceId)))
    },
  }
}

export type BookingLinksRepository = ReturnType<typeof createBookingLinksRepository>
