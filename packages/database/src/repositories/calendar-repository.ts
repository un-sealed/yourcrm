import { and, eq, gte, ilike, isNull, lte, or, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import { workspaces } from "../schema/core"
import {
  calendarEventAttendees,
  calendarEvents,
  isAttendeeResponseStatus,
  isCalendarEventStatus,
  type CalendarEvent,
  type CalendarEventAttendee,
  type NewCalendarEvent,
} from "../schema/calendar"
import { createBaseRepository } from "./base-repository"

export type CreateAttendeeInput = {
  userId?: string | null
  email?: string | null
  name?: string | null
  responseStatus?: string | null
  isOrganizer?: boolean | null
}

export type CreateCalendarEventInput = {
  title: string
  description?: string | null
  location?: string | null
  startAt: Date | string
  endAt: Date | string
  allDay?: boolean | null
  status?: string | null
  ownerId?: string | null
  personId?: string | null
  companyId?: string | null
  dealId?: string | null
  attendees?: CreateAttendeeInput[]
}

export type UpdateCalendarEventInput = Partial<
  Pick<
    NewCalendarEvent,
    | "title"
    | "description"
    | "location"
    | "allDay"
    | "ownerId"
    | "personId"
    | "companyId"
    | "dealId"
  >
> & {
  startAt?: Date | string
  endAt?: Date | string
  status?: string | null
  attendees?: CreateAttendeeInput[]
}

export type CalendarEventWithAttendees = {
  event: CalendarEvent
  attendees: CalendarEventAttendee[]
}

/** Trimmed, non-empty title (max 255, mirrors the column). */
export function normalizeEventTitle(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new Error("calendar.create: title must not be empty")
  if (trimmed.length > 255) throw new Error("calendar.create: title must be at most 255 characters")
  return trimmed
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validateAttendeeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase()
  if (!EMAIL_RE.test(trimmed)) throw new Error("calendar.attendee: email must be a valid address")
  if (trimmed.length > 320)
    throw new Error("calendar.attendee: email must be at most 320 characters")
  return trimmed
}

function toDate(value: Date | string, field: string): Date {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime()))
    throw new Error(`calendar.create: ${field} must be a valid date`)
  return date
}

/** Exactly one of userId (internal) or email (external) — mirrors the DB check constraint. */
function validateAttendeeTarget(input: CreateAttendeeInput): void {
  const hasUser = input.userId !== undefined && input.userId !== null && input.userId !== ""
  const hasEmail = input.email !== undefined && input.email !== null && input.email !== ""
  if (hasUser === hasEmail) {
    throw new Error(
      "calendar.attendee: exactly one of userId (internal) or email (external) is required",
    )
  }
}

function toEventValues(
  workspaceId: string,
  input: CreateCalendarEventInput | UpdateCalendarEventInput,
  actorId?: string,
): Partial<NewCalendarEvent> {
  const values: Partial<NewCalendarEvent> = {}
  if (input.title !== undefined) values.title = normalizeEventTitle(input.title)
  if (input.description !== undefined) values.description = input.description ?? null
  if (input.location !== undefined) values.location = input.location?.trim() || null
  if (input.startAt !== undefined) values.startAt = toDate(input.startAt, "startAt")
  if (input.endAt !== undefined) values.endAt = toDate(input.endAt, "endAt")
  if (input.allDay !== undefined) values.allDay = input.allDay ?? false
  if (input.ownerId !== undefined) values.ownerId = input.ownerId
  if (input.personId !== undefined) values.personId = input.personId
  if (input.companyId !== undefined) values.companyId = input.companyId
  if (input.dealId !== undefined) values.dealId = input.dealId
  if (input.status !== undefined) {
    if (input.status !== null && !isCalendarEventStatus(input.status)) {
      throw new Error("calendar.create: status must be one of confirmed, cancelled")
    }
    values.status = input.status ?? "confirmed"
  }
  if (actorId !== undefined) {
    values.updatedBy = actorId
  }
  return { ...values, workspaceId }
}

/**
 * Workspace-scoped calendar events + attendees. `personId`, `companyId` and
 * `dealId` stay plain columns (no joins) until those modules land; tags,
 * custom fields and activity timelines attach via the shared repositories.
 */
export function createCalendarRepository() {
  const base = createBaseRepository(calendarEvents)

  async function insertAttendees(
    db: Database,
    workspaceId: string,
    eventId: string,
    attendees: CreateAttendeeInput[],
    actorId?: string,
  ): Promise<void> {
    for (const item of attendees) {
      validateAttendeeTarget(item)
      if (item.responseStatus && !isAttendeeResponseStatus(item.responseStatus)) {
        throw new Error(
          "calendar.attendee: responseStatus must be one of needs_action, accepted, declined, tentative",
        )
      }
      await db.insert(calendarEventAttendees).values({
        workspaceId,
        eventId,
        userId: item.userId || null,
        email: item.email ? validateAttendeeEmail(item.email) : null,
        name: item.name?.trim() || null,
        responseStatus: item.responseStatus ?? "needs_action",
        isOrganizer: item.isOrganizer ?? false,
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      })
    }
  }

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateCalendarEventInput,
      actorId?: string,
    ): Promise<CalendarEvent> {
      const startAt = toDate(input.startAt, "startAt")
      const endAt = toDate(input.endAt, "endAt")
      if (endAt.getTime() < startAt.getTime()) {
        throw new Error("calendar.create: endAt must not be before startAt")
      }
      const rows = await db
        .insert(calendarEvents)
        .values({
          ...toEventValues(workspaceId, input, actorId),
          workspaceId,
          title: normalizeEventTitle(input.title),
          startAt,
          endAt,
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("calendar.create: insert returned no rows")
      await insertAttendees(db, workspaceId, row.id, input.attendees ?? [], actorId)
      return row
    },

    /** Cursor-paginated list with search, status filter and date-range overlap. */
    async search(
      db: Database,
      opts: { workspaceId: string; limit?: number; cursor?: string; order?: "asc" | "desc" } & {
        query?: string
        status?: string
        from?: string | Date
        to?: string | Date
        personId?: string
        companyId?: string
        dealId?: string
      },
    ) {
      const conditions: SQL[] = []
      if (opts.query) {
        const q = `%${opts.query.trim()}%`
        const textMatch = or(ilike(calendarEvents.title, q), ilike(calendarEvents.location, q))
        if (textMatch) conditions.push(textMatch)
      }
      if (opts.status) {
        if (!isCalendarEventStatus(opts.status))
          throw new Error("calendar.search: unknown status filter")
        conditions.push(eq(calendarEvents.status, opts.status))
      }
      // Overlap: an event [start, end] overlaps [from, to] when
      // end >= from AND start <= to.
      if (opts.from) conditions.push(gte(calendarEvents.endAt, toDate(opts.from, "from")))
      if (opts.to) conditions.push(lte(calendarEvents.startAt, toDate(opts.to, "to")))
      if (opts.personId) conditions.push(eq(calendarEvents.personId, opts.personId))
      if (opts.companyId) conditions.push(eq(calendarEvents.companyId, opts.companyId))
      if (opts.dealId) conditions.push(eq(calendarEvents.dealId, opts.dealId))
      const result = await base.list(db, { ...opts, where: conditions })
      return { data: result.data as CalendarEvent[], pagination: result.pagination }
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateCalendarEventInput,
      actorId?: string,
    ): Promise<CalendarEvent | null> {
      if (input.startAt !== undefined && input.endAt !== undefined) {
        const startAt = toDate(input.startAt, "startAt")
        const endAt = toDate(input.endAt, "endAt")
        if (endAt.getTime() < startAt.getTime()) {
          throw new Error("calendar.update: endAt must not be before startAt")
        }
      }
      const rows = await db
        .update(calendarEvents)
        .set({ ...toEventValues(workspaceId, input, actorId), updatedAt: new Date() })
        .where(
          and(
            eq(calendarEvents.id, id),
            eq(calendarEvents.workspaceId, workspaceId),
            isNull(calendarEvents.deletedAt),
          ),
        )
        .returning()
      const row = rows[0] ?? null
      if (row && input.attendees !== undefined) {
        await db
          .delete(calendarEventAttendees)
          .where(
            and(
              eq(calendarEventAttendees.eventId, id),
              eq(calendarEventAttendees.workspaceId, workspaceId),
            ),
          )
        await insertAttendees(db, workspaceId, id, input.attendees, actorId)
      }
      return row
    },

    async findById(db: Database, workspaceId: string, id: string): Promise<CalendarEvent | null> {
      // The shared base narrows rows to the BaseRecord columns; re-select the
      // concrete table here so callers get the full CalendarEvent shape.
      const row = await base.findById(db, workspaceId, id)
      return (row as CalendarEvent | null) ?? null
    },

    async findWithAttendees(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<CalendarEventWithAttendees | null> {
      const event = await this.findById(db, workspaceId, id)
      if (!event) return null
      const attendees = await db
        .select()
        .from(calendarEventAttendees)
        .where(
          and(
            eq(calendarEventAttendees.eventId, id),
            eq(calendarEventAttendees.workspaceId, workspaceId),
            isNull(calendarEventAttendees.deletedAt),
          ),
        )
      return { event, attendees }
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
  }
}

export type CalendarRepository = ReturnType<typeof createCalendarRepository>
