import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { baseColumns, ownerColumn, workspaceColumn } from "./base"

/**
 * Calendar module tables (spec 13-calendar, P0).
 *
 * SCOPE: internal events only. No Google Calendar, no Microsoft/Outlook, no
 * CalDAV, no OAuth, no external sync of any kind, no recurrence — those need
 * an integrations framework and OAuth credential storage that do not exist
 * in this repo yet (see docs/yourcrm-agent-spec-pack/13-calendar.md, P1/P2).
 *
 * - `calendarEvents`: one row per event. `startAt`/`endAt` are `timestamptz`
 *   (UTC) — rendering in the workspace's local timezone
 *   (`workspaces.timezone`) is a read-side concern
 *   (`packages/crm/src/calendar/timezone.ts`), never stored pre-converted.
 *   `personId`, `companyId`, `dealId` and `ownerId` are PLAIN uuid columns
 *   with an index and NO foreign key — those tables belong to other module
 *   agents and may not exist yet when this migration runs (same rule as
 *   `people.companyId` / `tasks.personId`).
 * - `calendarEventAttendees`: an attendee is either an internal user
 *   (`userId`, plain uuid — no FK, same rule as above: the users table is
 *   owned by the foundation auth module) or an external invitee (`email`).
 *   Exactly one of the two is set (DB check constraint + repository
 *   validation). `eventId` IS a real foreign key: both tables are owned by
 *   this module and defined in the same migration file.
 */

export const CALENDAR_EVENT_STATUSES = ["confirmed", "cancelled"] as const

export type CalendarEventStatus = (typeof CALENDAR_EVENT_STATUSES)[number]

export function isCalendarEventStatus(value: unknown): value is CalendarEventStatus {
  return typeof value === "string" && (CALENDAR_EVENT_STATUSES as readonly string[]).includes(value)
}

export const ATTENDEE_RESPONSE_STATUSES = [
  "needs_action",
  "accepted",
  "declined",
  "tentative",
] as const

export type AttendeeResponseStatus = (typeof ATTENDEE_RESPONSE_STATUSES)[number]

export function isAttendeeResponseStatus(value: unknown): value is AttendeeResponseStatus {
  return (
    typeof value === "string" && (ATTENDEE_RESPONSE_STATUSES as readonly string[]).includes(value)
  )
}

export const calendarEvents = pgTable(
  "calendar_events",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    location: varchar("location", { length: 500 }),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    allDay: boolean("all_day").notNull().default(false),
    status: varchar("status", { length: 32 }).notNull().default("confirmed"),
    // Cross-module references (plain uuid, no FK — see header comment).
    personId: uuid("person_id"),
    companyId: uuid("company_id"),
    dealId: uuid("deal_id"),
  },
  (t) => [
    index("calendar_events_workspace_idx").on(t.workspaceId),
    index("calendar_events_range_idx").on(t.workspaceId, t.startAt, t.endAt),
    index("calendar_events_status_idx").on(t.workspaceId, t.status),
    index("calendar_events_person_idx").on(t.personId),
    index("calendar_events_company_idx").on(t.companyId),
    index("calendar_events_deal_idx").on(t.dealId),
    check("calendar_events_time_range_chk", sql`${t.endAt} >= ${t.startAt}`),
  ],
)

export type CalendarEvent = typeof calendarEvents.$inferSelect
export type NewCalendarEvent = typeof calendarEvents.$inferInsert

export const calendarEventAttendees = pgTable(
  "calendar_event_attendees",
  {
    ...baseColumns,
    ...workspaceColumn,
    eventId: uuid("event_id")
      .notNull()
      .references(() => calendarEvents.id, { onDelete: "cascade" }),
    // Internal attendee (plain uuid, no FK — see header comment) XOR external.
    userId: uuid("user_id"),
    email: varchar("email", { length: 320 }),
    name: varchar("name", { length: 255 }),
    responseStatus: varchar("response_status", { length: 32 }).notNull().default("needs_action"),
    isOrganizer: boolean("is_organizer").notNull().default(false),
  },
  (t) => [
    index("calendar_event_attendees_event_idx").on(t.eventId),
    index("calendar_event_attendees_workspace_idx").on(t.workspaceId),
    index("calendar_event_attendees_user_idx").on(t.userId),
    uniqueIndex("calendar_event_attendees_user_uidx")
      .on(t.eventId, t.userId)
      .where(sql`${t.deletedAt} IS NULL AND ${t.userId} IS NOT NULL`),
    uniqueIndex("calendar_event_attendees_email_uidx")
      .on(t.eventId, sql`lower(${t.email})`)
      .where(sql`${t.deletedAt} IS NULL AND ${t.email} IS NOT NULL`),
    check(
      "calendar_event_attendees_target_chk",
      sql`(${t.userId} IS NOT NULL AND ${t.email} IS NULL) OR (${t.userId} IS NULL AND ${t.email} IS NOT NULL)`,
    ),
  ],
)

export type CalendarEventAttendee = typeof calendarEventAttendees.$inferSelect
export type NewCalendarEventAttendee = typeof calendarEventAttendees.$inferInsert
