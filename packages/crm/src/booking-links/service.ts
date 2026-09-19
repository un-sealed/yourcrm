import { fromWorkspaceLocalParts } from "../calendar"
import type { ServiceContext } from "../index"
import { requirePermission } from "@yourcrm/permissions"
import {
  bookingAvailabilityQuerySchema,
  bookingLinkQuerySchema,
  bookingQuerySchema,
  cancelBookingSchema,
  createBookingLinkSchema,
  createBookingSchema,
  replaceBookingAvailabilityRulesSchema,
  updateBookingLinkSchema,
} from "./schemas"
import { computeBookableSlots, isBookableSlot } from "./slots"
import type {
  BookingAvailabilityRuleRecord,
  BookingBusyInterval,
  BookingLinkListResult,
  BookingLinkRecord,
  BookingLinksServiceContext,
  BookingLinksServiceDeps,
  BookingLinkWithRules,
  BookingListResult,
  BookingRecord,
  BookingSlot,
} from "./types"

/**
 * Booking Links domain service (spec 48-booking-links, P0). Mirrors the
 * people reference (`../people/service.ts`) for the authenticated
 * management surface:
 *
 *  1. every authenticated method calls `requirePermission()` FIRST;
 *  2. does the work through the injected `BookingLinksStore` port;
 *  3. writes the audit row with before/after (mutations only).
 *
 * DOMAIN EVENTS (blocker — see the PR report): `@yourcrm/events` has no
 * booking event group (`BookingEvents`), unlike every sibling module
 * (`CrmEvents`, `CalendarEvents`, `FormEvents`, ...). Per the module's hard
 * rules, event constants must come from the `@yourcrm/events` package root
 * and string literals are not an acceptable workaround, so `booking.created`
 * / `booking.rescheduled` / `booking.cancelled` (spec section 9) are NOT
 * emitted here. Audit rows (which are free-form strings, not a shared enum)
 * still cover every mutation below. The calendar event created for a
 * confirmed booking goes through the real `CalendarService`, so
 * `calendar.event_created` (an existing, real constant) DOES fire for that
 * half of the flow.
 *
 * `getPublicLink` / `getAvailability` / `submitBooking` are the
 * unauthenticated public surface (mirrors `../forms/service.ts`'s
 * `getPublic` / `submit`): no actor exists, so instead of a permission
 * check they gate on the link being `active`, and their responses are
 * hand-built DTOs (never a passthrough of the stored row) so they cannot
 * leak owner identity, other bookings, or calendar event details.
 */

export class BookingLinkNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`booking link ${id} not found`)
    this.name = "BookingLinkNotFoundError"
  }
}

export class BookingNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`booking ${id} not found`)
    this.name = "BookingNotFoundError"
  }
}

/** The requested `startAt` is not (or no longer) a real bookable slot. */
export class BookingSlotUnavailableError extends Error {
  readonly code = "BOOKING_SLOT_UNAVAILABLE"
  constructor(startAt: string) {
    super(`booking.book: ${startAt} is not an available slot`)
    this.name = "BookingSlotUnavailableError"
  }
}

function permissionOf(
  ctx: BookingLinksServiceContext,
  action: "read" | "create" | "update" | "delete",
) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "booking_link",
    action,
  }
}

/** Read a numeric field off a pass-through record without `any`. */
function num(record: Record<string, unknown>, key: string, fallback = 0): number {
  const value = record[key]
  return typeof value === "number" ? value : fallback
}

function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

export function createBookingLinksService(deps: BookingLinksServiceDeps) {
  /**
   * Act "as the link owner" for calls into the calendar service. A booking
   * link's confirmed booking creates an event on its owner's calendar
   * exactly as if the owner had created it themselves, so the owner's own
   * identity is the correct actor — including from the public (no-session)
   * booking flow, which otherwise has no caller to attribute the write to.
   */
  function ownerCtx(bookingLink: BookingLinkRecord, correlationId?: string): ServiceContext {
    return {
      workspaceId: str(bookingLink, "workspaceId") ?? "",
      actorId: str(bookingLink, "ownerId") ?? "",
      role: "owner",
      correlationId,
    }
  }

  async function list(
    ctx: BookingLinksServiceContext,
    rawQuery: unknown,
  ): Promise<BookingLinkListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = bookingLinkQuerySchema.parse(rawQuery)
    return deps.store.list(ctx.workspaceId, query)
  }

  async function get(ctx: BookingLinksServiceContext, id: string): Promise<BookingLinkWithRules> {
    requirePermission(permissionOf(ctx, "read"))
    const found = await deps.store.findWithRules(ctx.workspaceId, id)
    if (!found) throw new BookingLinkNotFoundError(id)
    return found
  }

  async function create(
    ctx: BookingLinksServiceContext,
    rawInput: unknown,
  ): Promise<BookingLinkRecord> {
    requirePermission(permissionOf(ctx, "create"))
    const input = createBookingLinkSchema.parse(rawInput)
    const bookingLink = await deps.store.create(
      ctx.workspaceId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "booking_link",
      recordId: bookingLink.id,
      after: bookingLink,
      correlationId: ctx.correlationId,
    })
    return bookingLink
  }

  async function update(
    ctx: BookingLinksServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<BookingLinkRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const patch = updateBookingLinkSchema.parse(rawPatch)
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new BookingLinkNotFoundError(id)
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new BookingLinkNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "booking_link",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function softDelete(
    ctx: BookingLinksServiceContext,
    id: string,
  ): Promise<BookingLinkRecord> {
    requirePermission(permissionOf(ctx, "delete"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new BookingLinkNotFoundError(id)
    await deps.store.softDelete(ctx.workspaceId, id, ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "booking_link",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function restore(ctx: BookingLinksServiceContext, id: string): Promise<BookingLinkRecord> {
    requirePermission(permissionOf(ctx, "update"))
    await deps.store.restore(ctx.workspaceId, id)
    const after = await deps.store.findById(ctx.workspaceId, id)
    if (!after) throw new BookingLinkNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "restore",
      object: "booking_link",
      recordId: id,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function replaceRules(
    ctx: BookingLinksServiceContext,
    id: string,
    rawInput: unknown,
  ): Promise<BookingAvailabilityRuleRecord[]> {
    requirePermission(permissionOf(ctx, "update"))
    const { rules } = replaceBookingAvailabilityRulesSchema.parse(rawInput)
    const before = await deps.store.findWithRules(ctx.workspaceId, id)
    if (!before) throw new BookingLinkNotFoundError(id)
    const after = await deps.store.replaceRules(ctx.workspaceId, id, rules, ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "booking_availability_rule",
      recordId: id,
      before: before.rules,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function listBookings(
    ctx: BookingLinksServiceContext,
    bookingLinkId: string,
    rawQuery: unknown,
  ): Promise<BookingListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = bookingQuerySchema.parse(rawQuery)
    const link = await deps.store.findById(ctx.workspaceId, bookingLinkId)
    if (!link) throw new BookingLinkNotFoundError(bookingLinkId)
    return deps.store.listBookings(ctx.workspaceId, bookingLinkId, query)
  }

  async function cancelBooking(
    ctx: BookingLinksServiceContext,
    bookingLinkId: string,
    bookingId: string,
    rawInput: unknown,
  ): Promise<BookingRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const input = cancelBookingSchema.parse(rawInput ?? {})
    const link = await deps.store.findById(ctx.workspaceId, bookingLinkId)
    if (!link) throw new BookingLinkNotFoundError(bookingLinkId)
    const before = await deps.store.findBookingById(ctx.workspaceId, bookingId)
    if (!before || before.bookingLinkId !== bookingLinkId) throw new BookingNotFoundError(bookingId)
    const after = await deps.store.cancelBooking(
      ctx.workspaceId,
      bookingId,
      input.reason,
      ctx.actorId,
    )
    if (!after) throw new BookingNotFoundError(bookingId)
    // Cancel the linked calendar event too (through the calendar service) so
    // the slot is genuinely free again — otherwise the owner's calendar
    // would still show it as busy and future availability queries would
    // keep excluding it.
    const calendarEventId = str(before, "calendarEventId")
    if (calendarEventId) {
      await deps.calendar.update(ownerCtx(link, ctx.correlationId), calendarEventId, {
        status: "cancelled",
      })
    }
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "cancel",
      object: "booking",
      recordId: bookingId,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /** Busy intervals for the owner in `[fromUtc, toUtc]`: own bookings + confirmed calendar events. */
  async function collectBusyIntervals(
    bookingLink: BookingLinkRecord,
    fromUtc: Date,
    toUtc: Date,
  ): Promise<BookingBusyInterval[]> {
    const ownBookings = await deps.store.listActiveBookingsInRange(bookingLink.id, fromUtc, toUtc)
    const ctx = ownerCtx(bookingLink)
    const ownerId = str(bookingLink, "ownerId")
    const busyFromCalendar: BookingBusyInterval[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await deps.calendar.list(ctx, {
        from: fromUtc.toISOString(),
        to: toUtc.toISOString(),
        status: "confirmed",
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      })
      for (const evt of page.data as Record<string, unknown>[]) {
        if (ownerId !== undefined && str(evt, "ownerId") !== ownerId) continue
        const startAt = str(evt, "startAt")
        const endAt = str(evt, "endAt")
        if (!startAt || !endAt) continue
        busyFromCalendar.push({ startAt: new Date(startAt), endAt: new Date(endAt) })
      }
      cursor = page.pagination.nextCursor ?? undefined
      pages += 1
    } while (cursor && pages < 25)
    return [
      ...ownBookings.map((b) => ({ startAt: b.startAt, endAt: b.endAt })),
      ...busyFromCalendar,
    ]
  }

  /** Public: active-link-only lookup with no owner-identifying fields. */
  async function getPublicLink(slug: string): Promise<{
    slug: string
    title: string
    description: string | null
    durationMinutes: number
    location: string | null
    workspaceTimezone: string
  }> {
    const found = await deps.store.findActiveBySlug(slug)
    if (!found) throw new BookingLinkNotFoundError(slug)
    const { bookingLink } = found
    const workspaceTimezone = await deps.store.getWorkspaceTimezone(
      str(bookingLink, "workspaceId") ?? "",
    )
    return {
      slug: str(bookingLink, "slug") ?? slug,
      title: str(bookingLink, "title") ?? "",
      description: str(bookingLink, "description") ?? null,
      durationMinutes: num(bookingLink, "durationMinutes"),
      location: str(bookingLink, "location") ?? null,
      workspaceTimezone,
    }
  }

  /** Public: bookable slots only (free/busy) — never a busy interval's source. */
  async function getAvailability(slug: string, rawQuery: unknown): Promise<BookingSlot[]> {
    const query = bookingAvailabilityQuerySchema.parse(rawQuery)
    const found = await deps.store.findActiveBySlug(slug)
    if (!found) throw new BookingLinkNotFoundError(slug)
    const { bookingLink, rules } = found
    const workspaceTimezone = await deps.store.getWorkspaceTimezone(
      str(bookingLink, "workspaceId") ?? "",
    )
    const [fy, fm, fd] = query.from.split("-").map(Number)
    const rangeFromUtc = fromWorkspaceLocalMidnight(fy, fm, fd, query.timezone)
    const [ty, tm, td] = addCalendarDay(query.to)
    const rangeToUtc = new Date(
      fromWorkspaceLocalMidnight(ty, tm, td, query.timezone).getTime() - 1,
    )
    const busy = await collectBusyIntervals(bookingLink, rangeFromUtc, rangeToUtc)
    return computeBookableSlots({
      rules: rules.map((r) => ({
        dayOfWeek: num(r, "dayOfWeek"),
        startMinute: num(r, "startMinute"),
        endMinute: num(r, "endMinute"),
      })),
      durationMinutes: num(bookingLink, "durationMinutes"),
      bufferBeforeMinutes: num(bookingLink, "bufferBeforeMinutes"),
      bufferAfterMinutes: num(bookingLink, "bufferAfterMinutes"),
      minNoticeMinutes: num(bookingLink, "minNoticeMinutes"),
      maxDaysAhead: num(bookingLink, "maxDaysAhead", 30),
      workspaceTimezone,
      rangeFromUtc,
      rangeToUtc,
      busy,
    })
  }

  /**
   * Public: create a booking. Re-derives bookability server-side from the
   * same rule grid the availability list uses (never trusts the client's
   * chosen `startAt` at face value), then relies on the database's partial
   * unique index for the actual double-booking guarantee — see
   * `booking-links-repository.ts#createBooking`.
   */
  async function submitBooking(
    slug: string,
    rawInput: unknown,
    meta?: { correlationId?: string },
  ): Promise<BookingRecord> {
    const input = createBookingSchema.parse(rawInput)
    const found = await deps.store.findActiveBySlug(slug)
    if (!found) throw new BookingLinkNotFoundError(slug)
    const { bookingLink, rules } = found
    const workspaceTimezone = await deps.store.getWorkspaceTimezone(
      str(bookingLink, "workspaceId") ?? "",
    )
    const startAt = new Date(input.startAt)
    if (Number.isNaN(startAt.getTime())) throw new BookingSlotUnavailableError(input.startAt)
    const durationMinutes = num(bookingLink, "durationMinutes")
    const endAt = new Date(startAt.getTime() + durationMinutes * 60_000)

    const windowFrom = new Date(startAt.getTime() - 86_400_000)
    const windowTo = new Date(endAt.getTime() + 86_400_000)
    const busy = await collectBusyIntervals(bookingLink, windowFrom, windowTo)
    const slotOpts = {
      rules: rules.map((r) => ({
        dayOfWeek: num(r, "dayOfWeek"),
        startMinute: num(r, "startMinute"),
        endMinute: num(r, "endMinute"),
      })),
      durationMinutes,
      bufferBeforeMinutes: num(bookingLink, "bufferBeforeMinutes"),
      bufferAfterMinutes: num(bookingLink, "bufferAfterMinutes"),
      minNoticeMinutes: num(bookingLink, "minNoticeMinutes"),
      maxDaysAhead: num(bookingLink, "maxDaysAhead", 30),
      workspaceTimezone,
      rangeFromUtc: windowFrom,
      rangeToUtc: windowTo,
      busy,
    }
    if (!isBookableSlot(slotOpts, startAt)) throw new BookingSlotUnavailableError(input.startAt)

    // The database's partial unique index is the actual double-booking
    // guard: this insert either wins the slot or rejects with
    // BOOKING_SLOT_TAKEN (see booking-links-repository.ts).
    const booking = await deps.store.createBooking(
      str(bookingLink, "workspaceId") ?? "",
      bookingLink.id,
      {
        startsAt: startAt,
        endsAt: endAt,
        inviteeName: input.inviteeName,
        inviteeEmail: input.inviteeEmail,
        inviteeTimezone: input.inviteeTimezone,
        notes: input.notes,
      },
    )

    // A confirmed booking creates its calendar event THROUGH the calendar
    // domain service (never a second event model), acting as the link
    // owner. If that fails, release the slot instead of leaving a
    // confirmed booking with no calendar event.
    try {
      const ctx = ownerCtx(bookingLink, meta?.correlationId)
      const calendarEvent = await deps.calendar.create(ctx, {
        title: `${str(bookingLink, "title") ?? "Booking"} — ${input.inviteeName}`,
        description: input.notes ?? undefined,
        location: str(bookingLink, "location") ?? undefined,
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        ownerId: str(bookingLink, "ownerId"),
        attendees: [
          { email: input.inviteeEmail, name: input.inviteeName, responseStatus: "accepted" },
        ],
      })
      await deps.store.attachCalendarEvent(
        str(bookingLink, "workspaceId") ?? "",
        booking.id,
        calendarEvent.id,
      )
      await deps.audit({
        workspaceId: str(bookingLink, "workspaceId") ?? "",
        action: "create",
        object: "booking",
        recordId: booking.id,
        after: booking,
        correlationId: meta?.correlationId,
        source: "user",
      })
      return { ...booking, calendarEventId: calendarEvent.id }
    } catch (err) {
      await deps.store.cancelBooking(
        str(bookingLink, "workspaceId") ?? "",
        booking.id,
        "system: calendar event creation failed",
      )
      throw err
    }
  }

  return {
    list,
    get,
    create,
    update,
    softDelete,
    restore,
    replaceRules,
    listBookings,
    cancelBooking,
    getPublicLink,
    getAvailability,
    submitBooking,
  }
}

export type BookingLinksService = ReturnType<typeof createBookingLinksService>

// ---------------------------------------------------------------------------
// Small local date helpers (invitee-local date string -> UTC instant). The
// actual wall-clock <-> UTC conversion is entirely `fromWorkspaceLocalParts`
// (reused from the calendar module); these just parse/step YYYY-MM-DD text.
// ---------------------------------------------------------------------------

function fromWorkspaceLocalMidnight(
  year: number | undefined,
  month: number | undefined,
  day: number | undefined,
  timeZone: string,
): Date {
  return fromWorkspaceLocalParts(
    { year: year ?? 1970, month: month ?? 1, day: day ?? 1, hour: 0, minute: 0 },
    timeZone,
  )
}

function addCalendarDay(isoDate: string): [number, number, number] {
  const [y, m, d] = isoDate.split("-").map(Number)
  const ms = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + 86_400_000
  const dt = new Date(ms)
  return [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()]
}
