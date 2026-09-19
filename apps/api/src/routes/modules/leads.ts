import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  convertLeadSchema,
  createLeadSchema,
  createLeadsService,
  leadQuerySchema,
  leadSchema,
  updateLeadSchema,
  type LeadsService,
} from "@yourcrm/crm/src/leads"
import { getDb, writeAudit } from "@yourcrm/database"
import { createLeadsRepository } from "@yourcrm/database/src/repositories/leads-repository"
import type {
  CreateLeadInput,
  UpdateLeadInput,
} from "@yourcrm/database/src/repositories/leads-repository"
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
 * Leads module (spec 08-leads, P0) — mirrors the people golden reference.
 *
 * Thin HTTP layer only: zod validation at the boundary, session from the
 * auth middleware, then straight into the domain service. No business logic
 * lives here. Denials surface as 403, unknown ids as 404, all in the shared
 * error envelope with the request id echoed.
 */

export const basePath = "/leads"

const leadEnvelope = z.object({ data: leadSchema.passthrough() })
const leadListEnvelope = paginatedEnvelopeSchema(leadSchema.passthrough())

export type LeadsRouteDeps = {
  service?: LeadsService
}

function defaultService(): LeadsService {
  const db = getDb()
  const repository = createLeadsRepository()
  return createLeadsService({
    store: {
      list: (workspaceId, query) =>
        repository.search(db, {
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          query: query.query,
          status: query.status,
          source: query.source,
        }),
      findById: (workspaceId, id) => repository.findById(db, workspaceId, id),
      create: (workspaceId, input, actorId) =>
        repository.create(db, workspaceId, input as unknown as CreateLeadInput, actorId),
      update: (workspaceId, id, input, actorId) =>
        repository.update(db, workspaceId, id, input as unknown as UpdateLeadInput, actorId),
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

export function createRoutes(deps: LeadsRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  // The connection resolves on the first request that needs it (and then the
  // request fails loudly instead of crashing route setup).
  let cached: LeadsService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  app.get(
    "/",
    requireSession(),
    zValidator("query", leadQuerySchema, (result, c) => {
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
      const lead = await service().get(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: lead })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/",
    requireSession(),
    zValidator("json", createLeadSchema, (result, c) => {
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
        const lead = await service().create(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: lead }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.patch(
    "/:id",
    requireSession(),
    zValidator("json", updateLeadSchema, (result, c) => {
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
        const lead = await service().update(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: lead })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post("/:id/qualify", requireSession(), async (c) => {
    try {
      const lead = await service().qualify(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: lead })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/:id/convert",
    requireSession(),
    zValidator("json", convertLeadSchema, (result, c) => {
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
        const lead = await service().convert(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: lead })
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
      const lead = await service().restore(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: lead })
    } catch (err) {
      return mapError(c, err)
    }
  })

  return app
}

export const openApiPaths = {
  "/api/v1/leads": {
    get: {
      summary: "List leads (cursor pagination, search, status/source filter)",
      operationId: "listLeads",
    },
    post: {
      summary: "Create a lead",
      operationId: "createLead",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createLeadSchema) } },
      },
    },
  },
  "/api/v1/leads/{id}": {
    get: { summary: "Get a lead", operationId: "getLead" },
    patch: {
      summary: "Update a lead",
      operationId: "updateLead",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateLeadSchema) } },
      },
    },
    delete: { summary: "Soft-delete a lead", operationId: "deleteLead" },
  },
  "/api/v1/leads/{id}/qualify": {
    post: { summary: "Qualify a lead", operationId: "qualifyLead" },
  },
  "/api/v1/leads/{id}/convert": {
    post: {
      summary: "Convert a lead (stores target ids)",
      operationId: "convertLead",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(convertLeadSchema) } },
      },
    },
  },
  "/api/v1/leads/{id}/restore": {
    post: { summary: "Restore a soft-deleted lead", operationId: "restoreLead" },
  },
}

export { leadEnvelope, leadListEnvelope }
