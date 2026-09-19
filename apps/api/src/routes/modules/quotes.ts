import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  createQuoteSchema,
  createQuotesService,
  quoteQuerySchema,
  quoteSchema,
  updateQuoteSchema,
  type QuotesService,
} from "@yourcrm/crm/src/quotes"
import { getDb, writeAudit } from "@yourcrm/database"
import { createQuotesRepository } from "@yourcrm/database/src/repositories/quotes-repository"
import type {
  CreateQuoteInput,
  UpdateQuoteInput,
} from "@yourcrm/database/src/repositories/quotes-repository"
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
 * Quotes module (spec 19-quotes, P0) — mirrors the people reference; line
 * items + money mirror invoices.
 *
 * Thin HTTP layer only: zod validation at the boundary, session from the
 * auth middleware, then straight into the domain service. No business logic
 * lives here. Denials surface as 403, unknown ids as 404, invalid status
 * transitions as 409, all in the shared error envelope with the request id
 * echoed. Totals are always derived by the service from line items plus
 * discount/tax fields — never accepted from the client (the create/update
 * schemas have no total field to begin with). PDF generation is explicitly
 * out of scope for this module.
 */

export const basePath = "/quotes"

const quoteEnvelope = z.object({ data: quoteSchema.passthrough() })
const quoteDetailEnvelope = z.object({ data: quoteSchema.passthrough() })
const quoteListEnvelope = paginatedEnvelopeSchema(quoteSchema.passthrough())

export type QuotesRouteDeps = {
  service?: QuotesService
}

function defaultService(): QuotesService {
  const db = getDb()
  const repository = createQuotesRepository()
  return createQuotesService({
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
      findWithLineItems: (workspaceId, id) => repository.findWithLineItems(db, workspaceId, id),
      create: (workspaceId, input, actorId) =>
        repository.create(db, workspaceId, input as unknown as CreateQuoteInput, actorId),
      update: (workspaceId, id, input, actorId) =>
        repository.update(db, workspaceId, id, input as unknown as UpdateQuoteInput, actorId),
      softDelete: async (workspaceId, id, actorId) => {
        await repository.softDelete(db, workspaceId, id, actorId)
      },
      restore: async (workspaceId, id) => {
        await repository.restore(db, workspaceId, id)
      },
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
  if (err instanceof Error && (err as { code?: string }).code === "INVALID_TRANSITION") {
    return c.json(errorEnvelope("INVALID_TRANSITION", err.message, requestId), 409)
  }
  throw err
}

export function createRoutes(deps: QuotesRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  // The connection resolves on the first request that needs it (and then the
  // request fails loudly instead of crashing route setup).
  let cached: QuotesService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  app.get(
    "/",
    requireSession(),
    zValidator("query", quoteQuerySchema, (result, c) => {
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
      return c.json({
        data: { ...found.quote, lineItems: found.lineItems, totals: found.totals },
      })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/",
    requireSession(),
    zValidator("json", createQuoteSchema, (result, c) => {
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
        const created = await service().create(serviceContextOf(c), c.req.valid("json"))
        return c.json(
          { data: { ...created.quote, lineItems: created.lineItems, totals: created.totals } },
          201,
        )
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.patch(
    "/:id",
    requireSession(),
    zValidator("json", updateQuoteSchema, (result, c) => {
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
        const quote = await service().update(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: quote })
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
      const quote = await service().restore(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: quote })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post("/:id/send", requireSession(), async (c) => {
    try {
      const quote = await service().send(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: quote })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post("/:id/accept", requireSession(), async (c) => {
    try {
      const quote = await service().accept(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: quote })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post("/:id/reject", requireSession(), async (c) => {
    try {
      const quote = await service().reject(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: quote })
    } catch (err) {
      return mapError(c, err)
    }
  })

  return app
}

export const openApiPaths = {
  "/api/v1/quotes": {
    get: {
      summary: "List quotes (cursor pagination, search, status filter)",
      operationId: "listQuotes",
    },
    post: {
      summary: "Create a quote with line items",
      operationId: "createQuote",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createQuoteSchema) } },
      },
    },
  },
  "/api/v1/quotes/{id}": {
    get: {
      summary: "Get a quote with line items and server-computed totals",
      operationId: "getQuote",
    },
    patch: {
      summary: "Update a quote",
      operationId: "updateQuote",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateQuoteSchema) } },
      },
    },
    delete: { summary: "Soft-delete a quote", operationId: "deleteQuote" },
  },
  "/api/v1/quotes/{id}/restore": {
    post: { summary: "Restore a soft-deleted quote", operationId: "restoreQuote" },
  },
  "/api/v1/quotes/{id}/send": {
    post: { summary: "Send a draft quote (draft -> sent)", operationId: "sendQuote" },
  },
  "/api/v1/quotes/{id}/accept": {
    post: { summary: "Accept a sent quote (sent -> accepted)", operationId: "acceptQuote" },
  },
  "/api/v1/quotes/{id}/reject": {
    post: { summary: "Reject a sent quote (sent -> rejected)", operationId: "rejectQuote" },
  },
}

export { quoteDetailEnvelope, quoteEnvelope, quoteListEnvelope }
