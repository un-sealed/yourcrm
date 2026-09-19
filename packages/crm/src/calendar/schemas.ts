import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"

/**
 * Calendar zod schemas. Services validate inputs with these; API routes
 * reuse them at the HTTP boundary via `@hono/zod-validator`.
 *
 * `startAt` / `endAt` are ISO-8601 datetime strings. The repository stores
 * them as `timestamptz` (UTC); the web app renders them in the workspace
 * timezone (`workspaces.timezone`) — never the other way around.
 */

const titleSchema = z.string().trim().min(1).max(255)
const isoDateTime = z.string().datetime({ offset: true })

export const CALENDAR_EVENT_STATUSES = ["confirmed", "cancelled"] as const
export const ATTENDEE_RESPONSE_STATUSES = [
  "needs_action",
  "accepted",
  "declined",
  "tentative",
] as const

export const calendarAttendeeInputSchema = z
  .object({
    userId: z.string().trim().min(1).nullish(),
    email: z.string().trim().email().max(320).nullish(),
    name: z.string().trim().max(255).nullish(),
    responseStatus: z.enum(ATTENDEE_RESPONSE_STATUSES).nullish(),
    isOrganizer: z.boolean().nullish(),
  })
  .refine((value) => Boolean(value.userId) !== Boolean(value.email), {
    message: "attendee must have exactly one of userId (internal) or email (external)",
    path: ["email"],
  })

export type CalendarAttendeeInput = z.infer<typeof calendarAttendeeInputSchema>

const calendarEventFields = {
  title: titleSchema,
  description: z.string().max(10000).nullish(),
  location: z.string().trim().max(500).nullish(),
  startAt: isoDateTime,
  endAt: isoDateTime,
  allDay: z.boolean().default(false),
  status: z.enum(CALENDAR_EVENT_STATUSES).nullish(),
  ownerId: z.string().trim().min(1).nullish(),
  personId: z.string().trim().min(1).nullish(),
  companyId: z.string().trim().min(1).nullish(),
  dealId: z.string().trim().min(1).nullish(),
}

export const createCalendarEventSchema = z
  .object({
    ...calendarEventFields,
    attendees: z.array(calendarAttendeeInputSchema).max(50).default([]),
  })
  .refine((value) => new Date(value.endAt).getTime() >= new Date(value.startAt).getTime(), {
    message: "endAt must not be before startAt",
    path: ["endAt"],
  })

export type CreateCalendarEventInput = z.infer<typeof createCalendarEventSchema>

export const updateCalendarEventSchema = z
  .object({
    ...calendarEventFields,
    attendees: z.array(calendarAttendeeInputSchema).max(50).optional(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })
  .refine(
    (value) =>
      value.startAt === undefined ||
      value.endAt === undefined ||
      new Date(value.endAt).getTime() >= new Date(value.startAt).getTime(),
    { message: "endAt must not be before startAt", path: ["endAt"] },
  )

export type UpdateCalendarEventInput = z.infer<typeof updateCalendarEventSchema>

export const calendarEventQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
  status: z.enum(CALENDAR_EVENT_STATUSES).optional(),
  /** Inclusive UTC ISO range bounds: return events overlapping [from, to]. */
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  personId: z.string().trim().min(1).optional(),
  companyId: z.string().trim().min(1).optional(),
  dealId: z.string().trim().min(1).optional(),
})

export type CalendarEventQuery = z.infer<typeof calendarEventQuerySchema>

export const calendarAttendeeSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  userId: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  responseStatus: z.string(),
  isOrganizer: z.boolean(),
})

export type CalendarAttendeeDto = z.infer<typeof calendarAttendeeSchema>

export const calendarEventSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  ownerId: z.string().nullable().optional(),
  title: z.string(),
  description: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  startAt: z.unknown(),
  endAt: z.unknown(),
  allDay: z.boolean(),
  status: z.string(),
  personId: z.string().nullable().optional(),
  companyId: z.string().nullable().optional(),
  dealId: z.string().nullable().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type CalendarEventDto = z.infer<typeof calendarEventSchema>
