import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  calendarEventQuerySchema,
  calendarEventSchema,
  createCalendarEventSchema,
  createCalendarService,
  updateCalendarEventSchema,
  type CalendarService,
} from "@yourcrm/crm/src/calendar"
import { getDb, writeAudit } from "@yourcrm/database"
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
 * Calendar module (spec 13-calendar, P0) — mirrors the people module
 * (`./people.ts`, the golden reference).
 *
 * SCOPE: internal events only. No Google/Microsoft sync, no CalDAV, no
 * OAuth, no booking pages, no recurrence — see
 * `packages/crm/src/calendar/types.ts` for the full note.
 *
 * Thin HTTP layer only: zod validation at the boundary, session from the
 * auth middleware, then straight into the domain service. No business logic
 * lives here. Denials surface as 403, unknown ids as 404, all in the shared
 * error envelope with the request id echoed.
 *
 * List/get responses include `workspaceTimezone` (`workspaces.timezone`)
 * alongside the record(s): every timestamp on the wire is UTC ISO (as
 * stored); rendering it in the workspace's local timezone is the caller's
 * job (`@yourcrm/crm/src/calendar/timezone.ts` on the web side), and this
 * field is what makes that render correct without a second round trip.
 */

export const basePath = "/calendar-events"

const calendarAttendeeDtoSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  userId: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  responseStatus: z.string(),
  isOrganizer: z.boolean(),
})

const calendarEventEnvelope = z.object({
  data: calendarEventSchema.passthrough(),
  workspaceTimezone: z.string(),
})
const calendarEventDetailEnvelope = z.object({
  data: calendarEventSchema.passthrough().extend({ attendees: z.array(calendarAttendeeDtoSchema) }),
  workspaceTimezone: z.string(),
})
const calendarEventListEnvelope = paginatedEnvelopeSchema(calendarEventSchema.passthrough()).extend(
  {
    workspaceTimezone: z.string(),
  },
)

export type CalendarRouteDeps = {
  service?: CalendarService
}

function defaultService(): CalendarService {
  const db = getDb()
  const repository = createCalendarRepository()
  return createCalendarService({
    store: {
      list: (workspaceId, query) =>
        repository.search(db, {
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
      findById: (workspaceId, id) => repository.findById(db, workspaceId, id),
      findWithAttendees: (workspaceId, id) => repository.findWithAttendees(db, workspaceId, id),
      create: (workspaceId, input, actorId) =>
        repository.create(db, workspaceId, input as unknown as CreateCalendarEventInput, actorId),
      update: (workspaceId, id, input, actorId) =>
        repository.update(
          db,
          workspaceId,
          id,
          input as unknown as UpdateCalendarEventInput,
          actorId,
        ),
      softDelete: async (workspaceId, id, actorId) => {
        await repository.softDelete(db, workspaceId, id, actorId)
      },
      restore: async (workspaceId, id) => {
        await repository.restore(db, workspaceId, id)
      },
      getWorkspaceTimezone: (workspaceId) => repository.getWorkspaceTimezone(db, workspaceId),
    },
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "user" })
    },
    events: getEventBus(),
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
  throw err
}

export function createRoutes(deps: CalendarRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  // The connection resolves on the first request that needs it (and then the
  // request fails loudly instead of crashing route setup).
  let cached: CalendarService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  app.get(
    "/",
    requireSession(),
    zValidator("query", calendarEventQuerySchema, (result, c) => {
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
        const ctx = serviceContextOf(c)
        const [result, workspaceTimezone] = await Promise.all([
          service().list(ctx, c.req.valid("query")),
          service().getWorkspaceTimezone(ctx),
        ])
        return c.json({ ...result, workspaceTimezone })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/:id", requireSession(), async (c) => {
    try {
      const ctx = serviceContextOf(c)
      const [found, workspaceTimezone] = await Promise.all([
        service().get(ctx, c.req.param("id")),
        service().getWorkspaceTimezone(ctx),
      ])
      return c.json({
        data: { ...found.event, attendees: found.attendees },
        workspaceTimezone,
      })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/",
    requireSession(),
    zValidator("json", createCalendarEventSchema, (result, c) => {
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
        const event = await service().create(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: event }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.patch(
    "/:id",
    requireSession(),
    zValidator("json", updateCalendarEventSchema, (result, c) => {
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
        const event = await service().update(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: event })
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
      const event = await service().restore(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: event })
    } catch (err) {
      return mapError(c, err)
    }
  })

  return app
}

export const openApiPaths = {
  "/api/v1/calendar-events": {
    get: {
      summary: "List calendar events (cursor pagination, search, date-range, status filter)",
      operationId: "listCalendarEvents",
    },
    post: {
      summary: "Create a calendar event",
      operationId: "createCalendarEvent",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createCalendarEventSchema) } },
      },
    },
  },
  "/api/v1/calendar-events/{id}": {
    get: { summary: "Get a calendar event with attendees", operationId: "getCalendarEvent" },
    patch: {
      summary: "Update a calendar event",
      operationId: "updateCalendarEvent",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateCalendarEventSchema) } },
      },
    },
    delete: { summary: "Soft-delete a calendar event", operationId: "deleteCalendarEvent" },
  },
  "/api/v1/calendar-events/{id}/restore": {
    post: { summary: "Restore a soft-deleted calendar event", operationId: "restoreCalendarEvent" },
  },
}

export { calendarEventDetailEnvelope, calendarEventEnvelope, calendarEventListEnvelope }
