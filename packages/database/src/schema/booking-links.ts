import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { baseColumns, workspaceColumn } from "./base"

/**
 * Booking Links module tables (spec 48-booking-links, P0).
 *
 * SCOPE: a single owner per link, no payment collection, no round-robin/team
 * links, no Google/Microsoft calendar sync, no SMS reminders — see
 * docs/yourcrm-agent-spec-pack/48-booking-links.md.
 *
 * - `bookingLinks`: a public scheduling page (`/book/:slug`) owned by one
 *   CRM user. `ownerId` is a PLAIN uuid column with an index and NO foreign
 *   key — `users` is a foundation table owned by another module wave (same
 *   rule as `people.companyId` / `calendarEvents.ownerId`).
 * - `bookingAvailabilityRules`: weekly recurring windows in the *workspace's*
 *   local timezone (`workspaces.timezone`, reusing
 *   `packages/crm/src/calendar/timezone.ts` — never a second timezone
 *   helper). `dayOfWeek` follows `Date#getUTCDay()` (0 = Sunday).
 * - `bookings`: one row per confirmed/cancelled reservation.
 *   `calendarEventId` is a PLAIN uuid column with NO foreign key —
 *   `calendar_events` is owned by the calendar module; the row is created
 *   through the calendar domain service, never a second event model.
 *
 * DOUBLE-BOOKING GUARD: `bookingsLinkStartUidx` is a partial UNIQUE index on
 * `(bookingLinkId, startsAt)` filtered to `status = 'confirmed'`. Two
 * invitees racing the same slot cannot both insert a confirmed row — the
 * loser's INSERT fails with a Postgres unique-violation (23505), enforced by
 * the database regardless of any application-level race between the
 * availability check and the insert. See `booking-links-repository.ts`
 * (`BookingSlotTakenError`) for the translation and
 * `booking-links-repository.test.ts` for the proof.
 */

export const BOOKING_LINK_STATUSES = ["active", "archived"] as const

export type BookingLinkStatus = (typeof BOOKING_LINK_STATUSES)[number]

export function isBookingLinkStatus(value: unknown): value is BookingLinkStatus {
  return typeof value === "string" && (BOOKING_LINK_STATUSES as readonly string[]).includes(value)
}

export const BOOKING_STATUSES = ["confirmed", "cancelled"] as const

export type BookingStatus = (typeof BOOKING_STATUSES)[number]

export function isBookingStatus(value: unknown): value is BookingStatus {
  return typeof value === "string" && (BOOKING_STATUSES as readonly string[]).includes(value)
}

export const bookingLinks = pgTable(
  "booking_links",
  {
    ...baseColumns,
    ...workspaceColumn,
    ownerId: uuid("owner_id").notNull(),
    slug: varchar("slug", { length: 160 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    durationMinutes: integer("duration_minutes").notNull(),
    bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
    bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0),
    minNoticeMinutes: integer("min_notice_minutes").notNull().default(60),
    maxDaysAhead: integer("max_days_ahead").notNull().default(30),
    location: varchar("location", { length: 500 }),
    status: varchar("status", { length: 32 }).notNull().default("active"),
  },
  (t) => [
    index("booking_links_workspace_idx").on(t.workspaceId),
    index("booking_links_owner_idx").on(t.ownerId),
    index("booking_links_status_idx").on(t.workspaceId, t.status),
    uniqueIndex("booking_links_slug_uidx").on(sql`lower(${t.slug})`),
    check(
      "booking_links_duration_chk",
      sql`${t.durationMinutes} > 0 AND ${t.durationMinutes} <= 1440`,
    ),
    check(
      "booking_links_buffer_chk",
      sql`${t.bufferBeforeMinutes} >= 0 AND ${t.bufferAfterMinutes} >= 0`,
    ),
    check("booking_links_notice_chk", sql`${t.minNoticeMinutes} >= 0`),
    check("booking_links_horizon_chk", sql`${t.maxDaysAhead} > 0`),
  ],
)

export type BookingLink = typeof bookingLinks.$inferSelect
export type NewBookingLink = typeof bookingLinks.$inferInsert

export const bookingAvailabilityRules = pgTable(
  "booking_availability_rules",
  {
    ...baseColumns,
    ...workspaceColumn,
    bookingLinkId: uuid("booking_link_id")
      .notNull()
      .references(() => bookingLinks.id, { onDelete: "cascade" }),
    dayOfWeek: smallint("day_of_week").notNull(),
    startMinute: smallint("start_minute").notNull(),
    endMinute: smallint("end_minute").notNull(),
  },
  (t) => [
    index("booking_availability_rules_link_idx").on(t.bookingLinkId),
    index("booking_availability_rules_workspace_idx").on(t.workspaceId),
    check("booking_availability_rules_day_chk", sql`${t.dayOfWeek} BETWEEN 0 AND 6`),
    check(
      "booking_availability_rules_minutes_chk",
      sql`${t.startMinute} >= 0 AND ${t.endMinute} > ${t.startMinute} AND ${t.endMinute} <= 1440`,
    ),
  ],
)

export type BookingAvailabilityRule = typeof bookingAvailabilityRules.$inferSelect
export type NewBookingAvailabilityRule = typeof bookingAvailabilityRules.$inferInsert

export const bookings = pgTable(
  "bookings",
  {
    ...baseColumns,
    ...workspaceColumn,
    bookingLinkId: uuid("booking_link_id")
      .notNull()
      .references(() => bookingLinks.id, { onDelete: "cascade" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    inviteeName: varchar("invitee_name", { length: 255 }).notNull(),
    inviteeEmail: varchar("invitee_email", { length: 320 }).notNull(),
    inviteeTimezone: varchar("invitee_timezone", { length: 64 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("confirmed"),
    // Cross-module reference (plain uuid, no FK — see header comment).
    calendarEventId: uuid("calendar_event_id"),
    notes: text("notes"),
    cancellationReason: text("cancellation_reason"),
  },
  (t) => [
    index("bookings_link_idx").on(t.bookingLinkId),
    index("bookings_workspace_idx").on(t.workspaceId),
    index("bookings_status_idx").on(t.workspaceId, t.status),
    index("bookings_range_idx").on(t.bookingLinkId, t.startsAt, t.endsAt),
    // THE double-booking guard: see module header comment.
    uniqueIndex("bookings_link_start_uidx")
      .on(t.bookingLinkId, t.startsAt)
      .where(sql`${t.status} = 'confirmed'`),
    check("bookings_time_range_chk", sql`${t.endsAt} >= ${t.startsAt}`),
  ],
)

export type Booking = typeof bookings.$inferSelect
export type NewBooking = typeof bookings.$inferInsert
