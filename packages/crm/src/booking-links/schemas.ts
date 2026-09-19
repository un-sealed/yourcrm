import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"

/**
 * Booking Links zod schemas. Services validate inputs with these; API
 * routes reuse them at the HTTP boundary via `@hono/zod-validator` (same
 * split as people/calendar/forms).
 */

const titleSchema = z.string().trim().min(1).max(255)
const slugSchema = z
  .string()
  .trim()
  .min(3)
  .max(160)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase, alphanumeric and hyphen-separated")
const timezoneSchema = z.string().trim().min(1).max(64)
const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")

export const BOOKING_LINK_STATUSES = ["active", "archived"] as const
export const BOOKING_STATUSES = ["confirmed", "cancelled"] as const

export const bookingAvailabilityRuleInputSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
  })
  .refine((v) => v.endMinute > v.startMinute, {
    message: "endMinute must be after startMinute",
    path: ["endMinute"],
  })

export type BookingAvailabilityRuleInput = z.infer<typeof bookingAvailabilityRuleInputSchema>

const bookingLinkFields = {
  title: titleSchema,
  slug: slugSchema,
  description: z.string().trim().max(2000).nullish(),
  durationMinutes: z.number().int().min(5).max(1440),
  bufferBeforeMinutes: z.number().int().min(0).max(120).default(0),
  bufferAfterMinutes: z.number().int().min(0).max(120).default(0),
  minNoticeMinutes: z.number().int().min(0).max(10_080).default(60),
  maxDaysAhead: z.number().int().min(1).max(365).default(30),
  location: z.string().trim().max(500).nullish(),
  status: z.enum(BOOKING_LINK_STATUSES).nullish(),
  // Required (not nullish): every booking link always has an owner, whose
  // calendar the confirmed booking's event is created against — see
  // `service.ts` for why that context is required, not optional.
  ownerId: z.string().trim().min(1),
}

export const createBookingLinkSchema = z.object({
  ...bookingLinkFields,
  rules: z.array(bookingAvailabilityRuleInputSchema).max(50).default([]),
})

export type CreateBookingLinkInput = z.infer<typeof createBookingLinkSchema>

export const updateBookingLinkSchema = z
  .object({ ...bookingLinkFields })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateBookingLinkInput = z.infer<typeof updateBookingLinkSchema>

export const replaceBookingAvailabilityRulesSchema = z.object({
  rules: z.array(bookingAvailabilityRuleInputSchema).max(50),
})

export const bookingLinkQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
  status: z.enum(BOOKING_LINK_STATUSES).optional(),
})

export type BookingLinkQuery = z.infer<typeof bookingLinkQuerySchema>

export const bookingQuerySchema = paginationQuerySchema.omit({ sort: true }).extend({
  status: z.enum(BOOKING_STATUSES).optional(),
})

/**
 * Public availability request: an invitee-local calendar-date range plus
 * the invitee's IANA timezone. Capped at 62 days to bound server work — a
 * link's own `maxDaysAhead` is the real business-horizon limit.
 */
export const bookingAvailabilityQuerySchema = z
  .object({
    from: dateOnlySchema,
    to: dateOnlySchema,
    timezone: timezoneSchema,
  })
  .refine((v) => v.to >= v.from, { message: "to must not be before from", path: ["to"] })

export type BookingAvailabilityQuery = z.infer<typeof bookingAvailabilityQuerySchema>

export const createBookingSchema = z.object({
  // The exact UTC instant the invitee picked from the availability list.
  // The server re-derives bookability from the same rule grid rather than
  // trusting the client — see `service.ts#submitBooking`.
  startAt: z.string().datetime({ offset: true }),
  inviteeName: z.string().trim().min(1).max(255),
  inviteeEmail: z.string().trim().email().max(320),
  inviteeTimezone: timezoneSchema,
  notes: z.string().trim().max(2000).nullish(),
})

export type CreateBookingInput = z.infer<typeof createBookingSchema>

export const cancelBookingSchema = z.object({
  reason: z.string().trim().max(2000).nullish(),
})

// ---------------------------------------------------------------------------
// DTO schemas (response shapes)
// ---------------------------------------------------------------------------

export const bookingSlotSchema = z.object({
  startAt: z.string(),
  endAt: z.string(),
})

export type BookingSlotDto = z.infer<typeof bookingSlotSchema>

export const bookingAvailabilityRuleSchema = z.object({
  id: z.string(),
  bookingLinkId: z.string(),
  dayOfWeek: z.number(),
  startMinute: z.number(),
  endMinute: z.number(),
})

export type BookingAvailabilityRuleDto = z.infer<typeof bookingAvailabilityRuleSchema>

export const bookingLinkSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  ownerId: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  durationMinutes: z.number(),
  bufferBeforeMinutes: z.number(),
  bufferAfterMinutes: z.number(),
  minNoticeMinutes: z.number(),
  maxDaysAhead: z.number(),
  location: z.string().nullable().optional(),
  status: z.string(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type BookingLinkDto = z.infer<typeof bookingLinkSchema>

export const bookingSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  bookingLinkId: z.string(),
  startsAt: z.unknown(),
  endsAt: z.unknown(),
  inviteeName: z.string(),
  inviteeEmail: z.string(),
  inviteeTimezone: z.string(),
  status: z.string(),
  calendarEventId: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  cancellationReason: z.string().nullable().optional(),
  createdAt: z.unknown(),
})

export type BookingDto = z.infer<typeof bookingSchema>

/**
 * Public-safe booking-link view: deliberately NOT a passthrough of the
 * stored row — no owner id, no workspace id, no internal timestamps. Only
 * what an invitee needs to see the page and request availability.
 */
export const publicBookingLinkSchema = z.object({
  slug: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  durationMinutes: z.number(),
  location: z.string().nullable().optional(),
  workspaceTimezone: z.string(),
})

export type PublicBookingLinkDto = z.infer<typeof publicBookingLinkSchema>

/**
 * Public-safe booking confirmation: the invitee's own submission echoed
 * back, plus the slot — never another booking's details.
 */
export const publicBookingSchema = z.object({
  id: z.string(),
  startsAt: z.unknown(),
  endsAt: z.unknown(),
  inviteeName: z.string(),
  inviteeEmail: z.string(),
  inviteeTimezone: z.string(),
  status: z.string(),
})

export type PublicBookingDto = z.infer<typeof publicBookingSchema>
