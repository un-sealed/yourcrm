import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  createCompaniesService,
  createCompanySchema,
  companyQuerySchema,
  companySchema,
  updateCompanySchema,
  type CompaniesService,
} from "@yourcrm/crm/src/companies"
import { getDb, writeAudit } from "@yourcrm/database"
import { createCompaniesRepository } from "@yourcrm/database/src/repositories/companies-repository"
import type {
  CreateCompanyInput,
  UpdateCompanyInput,
} from "@yourcrm/database/src/repositories/companies-repository"
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
 * Companies module (spec 07-companies, P0) — mirrors the people module.
 *
 * Thin HTTP layer only: zod validation at the boundary, session from the
 * auth middleware, then straight into the domain service. No business logic
 * lives here. Denials surface as 403, unknown ids as 404, all in the shared
 * error envelope with the request id echoed.
 */

export const basePath = "/companies"

const companyEnvelope = z.object({ data: companySchema.passthrough() })
const companyListEnvelope = paginatedEnvelopeSchema(companySchema.passthrough())

export type CompaniesRouteDeps = {
  service?: CompaniesService
}

function defaultService(): CompaniesService {
  const db = getDb()
  const repository = createCompaniesRepository()
  return createCompaniesService({
    store: {
      list: (workspaceId, query) =>
        repository.search(db, {
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          query: query.query,
          status: query.status,
          industry: query.industry,
        }),
      findById: (workspaceId, id) => repository.findById(db, workspaceId, id),
      findWithAddresses: (workspaceId, id) => repository.findWithAddresses(db, workspaceId, id),
      listChildren: (workspaceId, parentId) => repository.listChildren(db, workspaceId, parentId),
      create: (workspaceId, input, actorId) =>
        repository.create(db, workspaceId, input as unknown as CreateCompanyInput, actorId),
      update: (workspaceId, id, input, actorId) =>
        repository.update(db, workspaceId, id, input as unknown as UpdateCompanyInput, actorId),
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

export function createRoutes(deps: CompaniesRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  // The connection resolves on the first request that needs it (and then the
  // request fails loudly instead of crashing route setup).
  let cached: CompaniesService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  app.get(
    "/",
    requireSession(),
    zValidator("query", companyQuerySchema, (result, c) => {
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
        data: { ...found.company, addresses: found.addresses, children: found.children },
      })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/",
    requireSession(),
    zValidator("json", createCompanySchema, (result, c) => {
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
        const company = await service().create(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: company }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.patch(
    "/:id",
    requireSession(),
    zValidator("json", updateCompanySchema, (result, c) => {
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
        const company = await service().update(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: company })
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
      const company = await service().restore(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: company })
    } catch (err) {
      return mapError(c, err)
    }
  })

  return app
}

export const openApiPaths = {
  "/api/v1/companies": {
    get: {
      summary: "List companies (cursor pagination, search, status/industry filter)",
      operationId: "listCompanies",
    },
    post: {
      summary: "Create a company",
      operationId: "createCompany",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createCompanySchema) } },
      },
    },
  },
  "/api/v1/companies/{id}": {
    get: { summary: "Get a company with addresses and child companies", operationId: "getCompany" },
    patch: {
      summary: "Update a company",
      operationId: "updateCompany",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateCompanySchema) } },
      },
    },
    delete: { summary: "Soft-delete a company", operationId: "deleteCompany" },
  },
  "/api/v1/companies/{id}/restore": {
    post: { summary: "Restore a soft-deleted company", operationId: "restoreCompany" },
  },
}

export { companyEnvelope, companyListEnvelope }
