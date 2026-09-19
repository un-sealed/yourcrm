import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  bookingAvailabilityQuerySchema,
  bookingLinkQuerySchema,
  bookingLinkSchema,
  bookingQuerySchema,
  bookingSchema,
  bookingSlotSchema,
  cancelBookingSchema,
  createBookingLinkSchema,
  createBookingSchema,
  createBookingLinksService,
  publicBookingLinkSchema,
  publicBookingSchema,
  replaceBookingAvailabilityRulesSchema,
  updateBookingLinkSchema,
  type BookingLinksService,
} from "@yourcrm/crm/src/booking-links"
import { createCalendarService } from "@yourcrm/crm/src/calendar"
import { getDb, writeAudit } from "@yourcrm/database"
import { createBookingLinksRepository } from "@yourcrm/database/src/repositories/booking-links-repository"
import type {
  AvailabilityRuleInput,
  CreateBookingLinkInput,
  UpdateBookingLinkInput,
} from "@yourcrm/database/src/repositories/booking-links-repository"
import { createCalendarRepository } from "@yourcrm/database/src/repositories/calendar-repository"
import type {
  CreateCalendarEventInput,
  UpdateCalendarEventInput,
} from "@yourcrm/database/src/repositories/calendar-repository"
import { getEventBus } from "@yourcrm/events"
import { PermissionDeniedError } from "@yourcrm/permissions"
import { errorEnvelope, paginatedEnvelopeSchema } from "@yourcrm/validation"
import { Hono } from "hono"
import type { Context } from "hono"
import { z } from "zod"
import type { AppEnv } from "../../hono-env"
import { requireSession } from "../../middleware/auth"
import { zodToJsonSchema } from "../../openapi/zod-to-json-schema"

/**
 * Booking Links module (spec 48-booking-links, P0) — mirrors the people
 * reference (`./people.ts`) for the authenticated management surface, and
 * the forms public-embed precedent (`./forms.ts`) for the unauthenticated
 * surface: `GET /public/:slug`, `GET /public/:slug/availability` and
 * `POST /public/:slug/book` take no session, are rate-limited per
 * slug+IP, and return hand-built DTOs — never a passthrough of the stored
 * row — so they cannot leak owner identity, other bookings, or calendar
 * event details (spec acceptance criterion: "Public booking page cannot
 * expose private calendar details").
 *
 * The calendar half of a confirmed booking goes through the REAL calendar
 * domain service (`@yourcrm/crm/src/calendar`), wired here exactly like
 * `./calendar.ts` wires its own — never a second event model.
 */

export const basePath = "/booking-links"

const bookingLinkEnvelope = z.object({ data: bookingLinkSchema.passthrough() })
const bookingLinkWithRulesEnvelope = z.object({
  data: bookingLinkSchema
    .passthrough()
    .and(z.object({ rules: z.array(z.record(z.string(), z.unknown())) })),
})
const bookingLinkListEnvelope = paginatedEnvelopeSchema(bookingLinkSchema.passthrough())
const bookingListEnvelope = paginatedEnvelopeSchema(bookingSchema.passthrough())
const bookingEnvelope = z.object({ data: bookingSchema.passthrough() })
const availabilityEnvelope = z.object({ data: z.array(bookingSlotSchema) })
const publicLinkEnvelope = z.object({ data: publicBookingLinkSchema })
const publicBookingEnvelope = z.object({ data: publicBookingSchema })

export type BookingLinksRouteDeps = {
  service?: BookingLinksService
}

function defaultService(): BookingLinksService {
  const db = getDb()
  const repository = createBookingLinksRepository()
  const calendarRepository = createCalendarRepository()
  const calendar = createCalendarService({
    store: {
      list: (workspaceId, query) =>
        calendarRepository.search(db, {
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          query: query.query,
          status: query.status,
          from: query.from,
          to: query.to,
          personId: query.personId,
          companyId: query.companyId,
          dealId: query.dealId,
        }),
      findById: (workspaceId, id) => calendarRepository.findById(db, workspaceId, id),
      findWithAttendees: (workspaceId, id) =>
        calendarRepository.findWithAttendees(db, workspaceId, id),
      create: (workspaceId, input, actorId) =>
        calendarRepository.create(
          db,
          workspaceId,
          input as unknown as CreateCalendarEventInput,
          actorId,
        ),
      update: (workspaceId, id, input, actorId) =>
        calendarRepository.update(
          db,
          workspaceId,
          id,
          input as unknown as UpdateCalendarEventInput,
          actorId,
        ),
      softDelete: async (workspaceId, id, actorId) => {
        await calendarRepository.softDelete(db, workspaceId, id, actorId)
      },
      restore: async (workspaceId, id) => {
        await calendarRepository.restore(db, workspaceId, id)
      },
      getWorkspaceTimezone: (workspaceId) =>
        calendarRepository.getWorkspaceTimezone(db, workspaceId),
    },
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "user" })
    },
    events: getEventBus(),
  })

  return createBookingLinksService({
    store: {
      list: (workspaceId, query) =>
        repository.search(db, {
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          query: query.query,
          status: query.status,
        }),
      findById: (workspaceId, id) => repository.findById(db, workspaceId, id),
      findWithRules: (workspaceId, id) => repository.findWithRules(db, workspaceId, id),
      findActiveBySlug: (slug) => repository.findActiveBySlug(db, slug),
      create: (workspaceId, input, actorId) =>
        repository.create(db, workspaceId, input as unknown as CreateBookingLinkInput, actorId),
      update: (workspaceId, id, input, actorId) =>
        repository.update(db, workspaceId, id, input as unknown as UpdateBookingLinkInput, actorId),
      softDelete: async (workspaceId, id, actorId) => {
        await repository.softDelete(db, workspaceId, id, actorId)
      },
      restore: async (workspaceId, id) => {
        await repository.restore(db, workspaceId, id)
      },
      replaceRules: (workspaceId, bookingLinkId, rules, actorId) =>
        repository.replaceRules(
          db,
          workspaceId,
          bookingLinkId,
          rules as AvailabilityRuleInput[],
          actorId,
        ),
      getWorkspaceTimezone: (workspaceId) => repository.getWorkspaceTimezone(db, workspaceId),
      listBookings: (workspaceId, bookingLinkId, query) =>
        repository.listBookings(db, {
          workspaceId,
          bookingLinkId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          status: query.status,
        }),
      listActiveBookingsInRange: async (bookingLinkId, fromUtc, toUtc) => {
        const rows = await repository.listActiveBookingsInRange(db, bookingLinkId, fromUtc, toUtc)
        return rows.map((r) => ({ startAt: r.startsAt, endAt: r.endsAt }))
      },
      createBooking: (workspaceId, bookingLinkId, input) =>
        repository.createBooking(db, workspaceId, bookingLinkId, input),
      findBookingById: (workspaceId, id) => repository.findBookingById(db, workspaceId, id),
      cancelBooking: (workspaceId, id, reason, actorId) =>
        repository.cancelBooking(db, workspaceId, id, reason, actorId),
      attachCalendarEvent: (workspaceId, bookingId, calendarEventId) =>
        repository.attachCalendarEvent(db, workspaceId, bookingId, calendarEventId),
    },
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "user" })
    },
    events: getEventBus(),
    calendar,
  })
}

function serviceContextOf(c: Context<AppEnv>) {
  const session = c.get("session") as Session | null
  return {
    workspaceId: session?.workspaceId ?? "",
    actorId: session?.user.id ?? "",
    role: session ? roleInWorkspace(session) : "viewer",
    correlationId: c.get("requestId") as string | undefined,
  }
}

function mapError(c: Context<AppEnv>, err: unknown) {
  const requestId = c.get("requestId") as string | undefined
  if (err instanceof PermissionDeniedError) {
    return c.json(errorEnvelope("FORBIDDEN", err.message, requestId), 403)
  }
  if (err instanceof Error && (err as { code?: string }).code === "NOT_FOUND") {
    return c.json(errorEnvelope("NOT_FOUND", err.message, requestId), 404)
  }
  if (err instanceof Error && (err as { code?: string }).code === "BOOKING_SLOT_TAKEN") {
    return c.json(errorEnvelope("CONFLICT", err.message, requestId), 409)
  }
  if (err instanceof Error && (err as { code?: string }).code === "BOOKING_SLOT_UNAVAILABLE") {
    return c.json(errorEnvelope("BOOKING_SLOT_UNAVAILABLE", err.message, requestId), 409)
  }
  if (err instanceof z.ZodError) {
    return c.json(
      errorEnvelope("VALIDATION_ERROR", "Invalid request", requestId, err.flatten()),
      400,
    )
  }
  throw err
}

// -- Public booking rate limiting (per slug + caller IP, sliding window). ---
// Same shape as `./forms.ts`'s `checkSubmitRateLimit` — kept local to this
// module rather than shared because the two windows/limits differ and a
// premature shared abstraction isn't worth it for two call sites.
const BOOK_WINDOW_MS = 10 * 60 * 1000
const BOOK_MAX_PER_WINDOW = 20
const bookHits = new Map<string, number[]>()

function bookRateKey(slug: string, ip: string): string {
  return `${slug}:${ip}`
}

export function checkBookRateLimit(slug: string, ip: string, now = Date.now()): boolean {
  const key = bookRateKey(slug, ip)
  const cutoff = now - BOOK_WINDOW_MS
  const hits = (bookHits.get(key) ?? []).filter((at) => at > cutoff)
  if (hits.length >= BOOK_MAX_PER_WINDOW) {
    bookHits.set(key, hits)
    return false
  }
  hits.push(now)
  bookHits.set(key, hits)
  if (bookHits.size > 10000) {
    for (const [k, v] of bookHits) {
      if (v.every((at) => at <= cutoff)) bookHits.delete(k)
    }
  }
  return true
}

export function resetBookRateLimits(): void {
  bookHits.clear()
}

function callerIp(c: Context<AppEnv>): string {
  const forwarded = c.req.header("x-forwarded-for")
  const first = forwarded?.split(",")[0]?.trim()
  return first && first !== "" ? first : "unknown"
}

/** Public booking DTO: the invitee's own submission — never another booking's details. */
function toPublicBooking(booking: Record<string, unknown>) {
  return {
    id: booking.id,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
    inviteeName: booking.inviteeName,
    inviteeEmail: booking.inviteeEmail,
    inviteeTimezone: booking.inviteeTimezone,
    status: booking.status,
  }
}

export function createRoutes(deps: BookingLinksRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  // The connection resolves on the first request that needs it (and then the
  // request fails loudly instead of crashing route setup).
  let cached: BookingLinksService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  // -- Public endpoints (no session) -----------------------------------------
  app.get("/public/:slug", async (c) => {
    try {
      const link = await service().getPublicLink(c.req.param("slug"))
      return c.json({ data: link })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.get(
    "/public/:slug/availability",
    zValidator("query", bookingAvailabilityQuerySchema, (result, c) => {
      if (!result.success) {
        return c.json(
          errorEnvelope(
            "VALIDATION_ERROR",
            "Invalid query parameters",
            c.req.header("x-request-id") ?? undefined,
            result.error.flatten(),
          ),
          400,
        )
      }
    }),
    async (c) => {
      try {
        const slots = await service().getAvailability(c.req.param("slug"), c.req.valid("query"))
        return c.json({ data: slots })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post(
    "/public/:slug/book",
    zValidator("json", createBookingSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          errorEnvelope(
            "VALIDATION_ERROR",
            "Invalid request body",
            c.req.header("x-request-id") ?? undefined,
            result.error.flatten(),
          ),
          400,
        )
      }
    }),
    async (c) => {
      try {
        const slug = c.req.param("slug")
        const ip = callerIp(c)
        if (!checkBookRateLimit(slug, ip)) {
          return c.json(
            errorEnvelope(
              "RATE_LIMITED",
              "Too many booking attempts. Please try again later.",
              c.get("requestId") as string | undefined,
            ),
            429,
          )
        }
        const booking = await service().submitBooking(slug, c.req.valid("json"), {
          correlationId: c.get("requestId") as string | undefined,
        })
        return c.json({ data: toPublicBooking(booking) }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  // -- Staff endpoints (session required) -------------------------------------
  app.get(
    "/",
    requireSession(),
    zValidator("query", bookingLinkQuerySchema, (result, c) => {
      if (!result.success) {
        return c.json(
          errorEnvelope(
            "VALIDATION_ERROR",
            "Invalid query parameters",
            c.req.header("x-request-id") ?? undefined,
            result.error.flatten(),
          ),
          400,
        )
      }
    }),
    async (c) => {
      try {
        const result = await service().list(serviceContextOf(c), c.req.valid("query"))
        return c.json(result)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/:id", requireSession(), async (c) => {
    try {
      const found = await service().get(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: { ...found.bookingLink, rules: found.rules } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/",
    requireSession(),
    zValidator("json", createBookingLinkSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          errorEnvelope(
            "VALIDATION_ERROR",
            "Invalid request body",
            c.req.header("x-request-id") ?? undefined,
            result.error.flatten(),
          ),
          400,
        )
      }
    }),
    async (c) => {
      try {
        const link = await service().create(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: link }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.patch(
    "/:id",
    requireSession(),
    zValidator("json", updateBookingLinkSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          errorEnvelope(
            "VALIDATION_ERROR",
            "Invalid request body",
            c.req.header("x-request-id") ?? undefined,
            result.error.flatten(),
          ),
          400,
        )
      }
    }),
    async (c) => {
      try {
        const link = await service().update(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: link })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.delete("/:id", requireSession(), async (c) => {
    try {
      await service().softDelete(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: { deleted: true } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post("/:id/restore", requireSession(), async (c) => {
    try {
      const link = await service().restore(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: link })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.put(
    "/:id/rules",
    requireSession(),
    zValidator("json", replaceBookingAvailabilityRulesSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          errorEnvelope(
            "VALIDATION_ERROR",
            "Invalid request body",
            c.req.header("x-request-id") ?? undefined,
            result.error.flatten(),
          ),
          400,
        )
      }
    }),
    async (c) => {
      try {
        const rules = await service().replaceRules(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: rules })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get(
    "/:id/bookings",
    requireSession(),
    zValidator("query", bookingQuerySchema, (result, c) => {
      if (!result.success) {
        return c.json(
          errorEnvelope(
            "VALIDATION_ERROR",
            "Invalid query parameters",
            c.req.header("x-request-id") ?? undefined,
            result.error.flatten(),
          ),
          400,
        )
      }
    }),
    async (c) => {
      try {
        const result = await service().listBookings(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("query"),
        )
        return c.json(result)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post(
    "/:id/bookings/:bookingId/cancel",
    requireSession(),
    zValidator("json", cancelBookingSchema.optional(), (result, c) => {
      if (!result.success) {
        return c.json(
          errorEnvelope(
            "VALIDATION_ERROR",
            "Invalid request body",
            c.req.header("x-request-id") ?? undefined,
            result.error.flatten(),
          ),
          400,
        )
      }
    }),
    async (c) => {
      try {
        const booking = await service().cancelBooking(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.param("bookingId"),
          c.req.valid("json") ?? {},
        )
        return c.json({ data: booking })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  return app
}

export const openApiPaths = {
  "/api/v1/booking-links": {
    get: {
      summary: "List booking links (cursor pagination, search, status filter)",
      operationId: "listBookingLinks",
    },
    post: {
      summary: "Create a booking link with optional weekly availability rules",
      operationId: "createBookingLink",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createBookingLinkSchema) } },
      },
    },
  },
  "/api/v1/booking-links/{id}": {
    get: {
      summary: "Get a booking link with its availability rules",
      operationId: "getBookingLink",
    },
    patch: {
      summary: "Update a booking link",
      operationId: "updateBookingLink",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateBookingLinkSchema) } },
      },
    },
    delete: { summary: "Soft-delete a booking link", operationId: "deleteBookingLink" },
  },
  "/api/v1/booking-links/{id}/restore": {
    post: { summary: "Restore a soft-deleted booking link", operationId: "restoreBookingLink" },
  },
  "/api/v1/booking-links/{id}/rules": {
    put: {
      summary: "Replace the weekly availability rules",
      operationId: "replaceBookingAvailabilityRules",
      requestBody: {
        content: {
          "application/json": { schema: zodToJsonSchema(replaceBookingAvailabilityRulesSchema) },
        },
      },
    },
  },
  "/api/v1/booking-links/{id}/bookings": {
    get: { summary: "List bookings for a link", operationId: "listBookings" },
  },
  "/api/v1/booking-links/{id}/bookings/{bookingId}/cancel": {
    post: {
      summary: "Cancel a booking (also cancels its calendar event)",
      operationId: "cancelBooking",
    },
  },
  "/api/v1/booking-links/public/{slug}": {
    get: {
      summary: "Public booking-link lookup (free/busy only)",
      operationId: "getPublicBookingLink",
    },
  },
  "/api/v1/booking-links/public/{slug}/availability": {
    get: {
      summary: "Public bookable-slot list in the invitee's timezone",
      operationId: "getPublicAvailability",
    },
  },
  "/api/v1/booking-links/public/{slug}/book": {
    post: {
      summary: "Public booking submission (rate-limited)",
      operationId: "submitPublicBooking",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createBookingSchema) } },
      },
    },
  },
}

export {
  availabilityEnvelope,
  bookingEnvelope,
  bookingListEnvelope,
  bookingLinkEnvelope,
  bookingLinkListEnvelope,
  bookingLinkWithRulesEnvelope,
  publicBookingEnvelope,
  publicLinkEnvelope,
}
