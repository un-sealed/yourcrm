import type { CalendarService } from "../calendar"
import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"

/**
 * Booking Links service ports (spec 48-booking-links, P0). Mirrors the
 * people module pattern (`../people/types.ts`) for the authenticated
 * management surface, plus a small public (no-actor) surface for the
 * unauthenticated availability/booking endpoints — same shape as
 * `../forms/types.ts` (`findPublicByToken` / `findPublishedById`).
 *
 * `@yourcrm/crm` has no database dependency, so the service never imports
 * `@yourcrm/database`. It depends on these structural ports instead; the API
 * layer adapts the drizzle repository (`booking-links-repository.ts`) and
 * `writeAudit` to them.
 *
 * A confirmed booking creates its calendar event *through the calendar
 * domain service* (`CalendarService`, imported from the sibling `../calendar`
 * module and injected as `BookingLinksServiceDeps.calendar`) rather than a
 * second event model or a second timezone helper — see `service.ts` for how
 * the acting context is derived (the link owner) so the permissioned
 * calendar service can be called from an unauthenticated public flow.
 */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type BookingLinkRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
}

export type BookingAvailabilityRuleRecord = Record<string, unknown> & {
  id: string
  bookingLinkId: string
}

export type BookingRecord = Record<string, unknown> & {
  id: string
  bookingLinkId: string
}

export type BookingLinkWithRules = {
  bookingLink: BookingLinkRecord
  rules: BookingAvailabilityRuleRecord[]
}

export type BookingLinkListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
  status?: string
}

export type BookingLinkListResult = {
  data: BookingLinkRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type BookingListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  status?: string
}

export type BookingListResult = {
  data: BookingRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

/** A single bookable window, always UTC ISO instants — the wire truth. */
export type BookingSlot = {
  startAt: string
  endAt: string
}

/** Busy interval used to exclude slots (own bookings + the owner's calendar events). */
export type BookingBusyInterval = {
  startAt: Date
  endAt: Date
}

export type BookingAvailabilityRuleInput = {
  dayOfWeek: number
  startMinute: number
  endMinute: number
}

export type CreateBookingInput = {
  startsAt: string | Date
  endsAt: string | Date
  inviteeName: string
  inviteeEmail: string
  inviteeTimezone: string
  notes?: string | null
}

export type BookingLinksStore = {
  list(workspaceId: string, query: BookingLinkListQuery): Promise<BookingLinkListResult>
  findById(workspaceId: string, id: string): Promise<BookingLinkRecord | null>
  findWithRules(workspaceId: string, id: string): Promise<BookingLinkWithRules | null>
  /** Public lookup: active links only, no workspace scope. */
  findActiveBySlug(slug: string): Promise<BookingLinkWithRules | null>
  create(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<BookingLinkRecord>
  update(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<BookingLinkRecord | null>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  restore(workspaceId: string, id: string): Promise<void>
  replaceRules(
    workspaceId: string,
    bookingLinkId: string,
    rules: BookingAvailabilityRuleInput[],
    actorId?: string,
  ): Promise<BookingAvailabilityRuleRecord[]>
  /** `workspaces.timezone` (IANA name). Defaults to `"UTC"`. */
  getWorkspaceTimezone(workspaceId: string): Promise<string>
  listBookings(
    workspaceId: string,
    bookingLinkId: string,
    query: BookingListQuery,
  ): Promise<BookingListResult>
  /** Busy start/end pairs only — no invitee PII crosses this boundary. */
  listActiveBookingsInRange(
    bookingLinkId: string,
    fromUtc: Date,
    toUtc: Date,
  ): Promise<BookingBusyInterval[]>
  /**
   * Rejects with an error whose `code` is `"BOOKING_SLOT_TAKEN"` when the
   * requested start is already confirmed — enforced by the database's
   * partial unique index, not a check-then-insert race in this port.
   */
  createBooking(
    workspaceId: string,
    bookingLinkId: string,
    input: CreateBookingInput,
  ): Promise<BookingRecord>
  findBookingById(workspaceId: string, id: string): Promise<BookingRecord | null>
  cancelBooking(
    workspaceId: string,
    id: string,
    reason?: string | null,
    actorId?: string,
  ): Promise<BookingRecord | null>
  attachCalendarEvent(
    workspaceId: string,
    bookingId: string,
    calendarEventId: string,
  ): Promise<void>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type BookingLinkAuditInput = {
  workspaceId: string
  actorId?: string | null
  action: string
  object: string
  recordId?: string | null
  before?: unknown
  after?: unknown
  correlationId?: string | null
  source?: "user" | "automation" | "ai" | "integration" | "mcp"
}

export type BookingLinksServiceContext = ServiceContext

export type BookingLinksServiceDeps = {
  store: BookingLinksStore
  audit: AuditWriter<BookingLinkAuditInput>
  events?: EventEmitter
  /** The calendar domain service — a confirmed booking creates its event through it. */
  calendar: Pick<CalendarService, "create" | "list" | "update" | "getWorkspaceTimezone">
}
