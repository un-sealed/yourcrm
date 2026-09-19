import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  createSupportTicketCommentSchema,
  createSupportTicketSchema,
  createSupportTicketService,
  supportTicketQuerySchema,
  supportTicketSchema,
  transitionSupportTicketSchema,
  updateSupportTicketSchema,
  type SupportTicketService,
} from "@yourcrm/crm/src/support"
import { getDb, writeAudit } from "@yourcrm/database"
import { createSupportTicketRepository } from "@yourcrm/database/src/repositories/support-repository"
import type {
  CreateSupportTicketCommentInput,
  CreateSupportTicketInput,
  UpdateSupportTicketInput,
} from "@yourcrm/database/src/repositories/support-repository"
import { PermissionDeniedError } from "@yourcrm/permissions"
import { errorEnvelope, paginatedEnvelopeSchema } from "@yourcrm/validation"
import { Hono } from "hono"
import type { Context } from "hono"
import { z } from "zod"
import type { AppEnv } from "../../hono-env"
import { requireSession } from "../../middleware/auth"
import { zodToJsonSchema } from "../../openapi/zod-to-json-schema"

/**
 * Support / Ticketing module (spec 21-support, P0) — mirrors the people
 * reference module; status lifecycle mirrors the quotes send/accept/reject
 * pattern, generalized to one `/status` transition endpoint since tickets
 * have five states and more than three edges (see `service.ts`).
 *
 * Thin HTTP layer only: zod validation at the boundary, session from the
 * auth middleware, then straight into the domain service. No business logic
 * lives here. Denials surface as 403, unknown ids as 404, invalid status
 * transitions as 409, all in the shared error envelope with the request id
 * echoed.
 *
 * NO event emission here (see `service.ts`'s EVENTS BLOCKER note): there is
 * currently no `TicketEvents` group in `@yourcrm/events`, so `getEventBus()`
 * is deliberately not wired into `defaultService()` below — nothing to emit
 * yet, and wiring an unused bus would be dead weight.
 *
 * NO requester-facing routes here either: the customer portal (spec 45) is
 * out of scope for this module. `SupportTicketService.getForRequester` is
 * the tested seam that portal work will call; nothing here exposes it over
 * HTTP.
 */

export const basePath = "/tickets"

const supportTicketEnvelope = z.object({ data: supportTicketSchema.passthrough() })
const supportTicketListEnvelope = paginatedEnvelopeSchema(supportTicketSchema.passthrough())

export type SupportRouteDeps = {
  service?: SupportTicketService
}

function defaultService(): SupportTicketService {
  const db = getDb()
  const repository = createSupportTicketRepository()
  return createSupportTicketService({
    store: {
      list: (workspaceId, query) =>
        repository.search(db, {
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          query: query.query,
          status: query.status,
          priority: query.priority,
          assigneeId: query.assigneeId,
          requesterId: query.requesterId,
        }),
      findById: (workspaceId, id) => repository.findById(db, workspaceId, id),
      findWithComments: (workspaceId, id) => repository.findWithComments(db, workspaceId, id),
      create: (workspaceId, input, actorId) =>
        repository.create(db, workspaceId, input as unknown as CreateSupportTicketInput, actorId),
      update: (workspaceId, id, input, actorId) =>
        repository.update(
          db,
          workspaceId,
          id,
          input as unknown as UpdateSupportTicketInput,
          actorId,
        ),
      softDelete: async (workspaceId, id, actorId) => {
        await repository.softDelete(db, workspaceId, id, actorId)
      },
      restore: async (workspaceId, id) => {
        await repository.restore(db, workspaceId, id)
      },
      addComment: (workspaceId, ticketId, input, actorId) =>
        repository.addComment(
          db,
          workspaceId,
          ticketId,
          input as unknown as CreateSupportTicketCommentInput,
          actorId,
        ),
    },
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "user" })
    },
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
  if (err instanceof Error && (err as { code?: string }).code === "INVALID_TRANSITION") {
    return c.json(errorEnvelope("INVALID_TRANSITION", err.message, requestId), 409)
  }
  throw err
}

export function createRoutes(deps: SupportRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  // The connection resolves on the first request that needs it (and then the
  // request fails loudly instead of crashing route setup).
  let cached: SupportTicketService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  app.get(
    "/",
    requireSession(),
    zValidator("query", supportTicketQuerySchema, (result, c) => {
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
      return c.json({ data: { ...found.ticket, comments: found.comments } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/",
    requireSession(),
    zValidator("json", createSupportTicketSchema, (result, c) => {
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
        const ticket = await service().create(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: ticket }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.patch(
    "/:id",
    requireSession(),
    zValidator("json", updateSupportTicketSchema, (result, c) => {
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
        const ticket = await service().update(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: ticket })
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
      const ticket = await service().restore(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: ticket })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/:id/status",
    requireSession(),
    zValidator("json", transitionSupportTicketSchema, (result, c) => {
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
        const ticket = await service().transition(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: ticket })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post(
    "/:id/comments",
    requireSession(),
    zValidator("json", createSupportTicketCommentSchema, (result, c) => {
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
        const result = await service().addComment(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: result }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  return app
}

export const openApiPaths = {
  "/api/v1/tickets": {
    get: {
      summary: "List tickets (cursor pagination, search, status/priority/assignee filters)",
      operationId: "listTickets",
    },
    post: {
      summary: "Create a ticket (SLA due dates computed server-side from priority)",
      operationId: "createTicket",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createSupportTicketSchema) } },
      },
    },
  },
  "/api/v1/tickets/{id}": {
    get: { summary: "Get a ticket with its full staff comment thread", operationId: "getTicket" },
    patch: {
      summary: "Update a ticket (subject/description/priority/assignee/channel; not status)",
      operationId: "updateTicket",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateSupportTicketSchema) } },
      },
    },
    delete: { summary: "Soft-delete a ticket", operationId: "deleteTicket" },
  },
  "/api/v1/tickets/{id}/restore": {
    post: { summary: "Restore a soft-deleted ticket", operationId: "restoreTicket" },
  },
  "/api/v1/tickets/{id}/status": {
    post: {
      summary: "Transition ticket status (validated against the explicit transition table)",
      operationId: "transitionTicket",
      requestBody: {
        content: {
          "application/json": { schema: zodToJsonSchema(transitionSupportTicketSchema) },
        },
      },
    },
  },
  "/api/v1/tickets/{id}/comments": {
    post: {
      summary: "Add a comment (public reply or internal note)",
      operationId: "addTicketComment",
      requestBody: {
        content: {
          "application/json": { schema: zodToJsonSchema(createSupportTicketCommentSchema) },
        },
      },
    },
  },
}

export { supportTicketEnvelope, supportTicketListEnvelope }
