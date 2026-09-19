import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  createInvoicesService,
  createInvoiceSchema,
  invoiceQuerySchema,
  invoiceSchema,
  recordPaymentSchema,
  updateInvoiceSchema,
  type InvoicesService,
} from "@yourcrm/crm/src/invoices"
import type {
  CreateInvoiceInput,
  CreatePaymentInput,
  UpdateInvoiceInput,
} from "@yourcrm/database/src/repositories/invoices-repository"
import { getDb, writeAudit } from "@yourcrm/database"
import { createInvoicesRepository } from "@yourcrm/database/src/repositories/invoices-repository"
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
 * Invoices module (spec 20-invoices-payments, P0) — mirrors the people
 * reference.
 *
 * Thin HTTP layer only: zod validation at the boundary, session from the
 * auth middleware, then straight into the domain service. No business logic
 * lives here. Denials surface as 403, unknown ids as 404, all in the shared
 * error envelope with the request id echoed. The balance due is derived by
 * the service from line items and payments, never accepted from the client.
 */

export const basePath = "/invoices"

const invoiceEnvelope = z.object({ data: invoiceSchema.passthrough() })
const invoiceDetailEnvelope = z.object({ data: invoiceSchema.passthrough() })
const invoiceListEnvelope = paginatedEnvelopeSchema(invoiceSchema.passthrough())

export type InvoicesRouteDeps = {
  service?: InvoicesService
}

function defaultService(): InvoicesService {
  const db = getDb()
  const repository = createInvoicesRepository()
  return createInvoicesService({
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
      findWithDetails: (workspaceId, id) => repository.findWithDetails(db, workspaceId, id),
      create: (workspaceId, input, actorId) =>
        repository.create(db, workspaceId, input as unknown as CreateInvoiceInput, actorId),
      update: (workspaceId, id, input, actorId) =>
        repository.update(db, workspaceId, id, input as unknown as UpdateInvoiceInput, actorId),
      recordPayment: (workspaceId, invoiceId, input, actorId) =>
        repository.recordPayment(
          db,
          workspaceId,
          invoiceId,
          input as unknown as CreatePaymentInput,
          actorId,
        ),
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
  throw err
}

export function createRoutes(deps: InvoicesRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  // The connection resolves on the first request that needs it (and then the
  // request fails loudly instead of crashing route setup).
  let cached: InvoicesService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  app.get(
    "/",
    requireSession(),
    zValidator("query", invoiceQuerySchema, (result, c) => {
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
        data: {
          ...found.invoice,
          lineItems: found.lineItems,
          payments: found.payments,
          totals: found.totals,
        },
      })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/",
    requireSession(),
    zValidator("json", createInvoiceSchema, (result, c) => {
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
          {
            data: {
              ...created.invoice,
              lineItems: created.lineItems,
              payments: created.payments,
              totals: created.totals,
            },
          },
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
    zValidator("json", updateInvoiceSchema, (result, c) => {
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
        const invoice = await service().update(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: invoice })
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
      const invoice = await service().restore(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: invoice })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post("/:id/send", requireSession(), async (c) => {
    try {
      const invoice = await service().send(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: invoice })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/:id/payments",
    requireSession(),
    zValidator("json", recordPaymentSchema, (result, c) => {
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
        const result = await service().recordPayment(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json(
          {
            data: {
              ...result.invoice,
              lineItems: result.lineItems,
              payments: result.payments,
              totals: result.totals,
            },
          },
          201,
        )
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  return app
}

export const openApiPaths = {
  "/api/v1/invoices": {
    get: {
      summary: "List invoices (cursor pagination, search, status filter)",
      operationId: "listInvoices",
    },
    post: {
      summary: "Create an invoice with line items",
      operationId: "createInvoice",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createInvoiceSchema) } },
      },
    },
  },
  "/api/v1/invoices/{id}": {
    get: { summary: "Get an invoice with line items, payments and totals", operationId: "getInvoice" },
    patch: {
      summary: "Update an invoice",
      operationId: "updateInvoice",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateInvoiceSchema) } },
      },
    },
    delete: { summary: "Soft-delete an invoice", operationId: "deleteInvoice" },
  },
  "/api/v1/invoices/{id}/restore": {
    post: { summary: "Restore a soft-deleted invoice", operationId: "restoreInvoice" },
  },
  "/api/v1/invoices/{id}/send": {
    post: { summary: "Send a draft invoice", operationId: "sendInvoice" },
  },
  "/api/v1/invoices/{id}/payments": {
    post: {
      summary: "Record a manual payment against an invoice",
      operationId: "recordInvoicePayment",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(recordPaymentSchema) } },
      },
    },
  },
}

export { invoiceDetailEnvelope, invoiceEnvelope, invoiceListEnvelope }
