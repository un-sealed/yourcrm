import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  changeDealStageSchema,
  closeDealSchema,
  createDealSchema,
  createDealsService,
  dealQuerySchema,
  dealSchema,
  updateDealSchema,
  type DealsService,
} from "@yourcrm/crm/src/deals"
import { getDb, writeAudit } from "@yourcrm/database"
import { createDealsRepository } from "@yourcrm/database/src/repositories/deals-repository"
import type {
  ChangeDealStageInput,
  CloseDealInput,
  CreateDealInput,
  UpdateDealInput,
} from "@yourcrm/database/src/repositories/deals-repository"
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
 * Deals module (spec 09-deals, P0) — mirrors the people golden reference.
 *
 * Thin HTTP layer only: zod validation at the boundary, session from the
 * auth middleware, then straight into the domain service. No business logic
 * lives here. Denials surface as 403, unknown ids as 404, all in the shared
 * error envelope with the request id echoed.
 */

export const basePath = "/deals"

const dealEnvelope = z.object({ data: dealSchema.passthrough() })
const dealListEnvelope = paginatedEnvelopeSchema(dealSchema.passthrough())

export type DealsRouteDeps = {
  service?: DealsService
}

function defaultService(): DealsService {
  const db = getDb()
  const repository = createDealsRepository()
  return createDealsService({
    store: {
      list: (workspaceId, query) =>
        repository.search(db, {
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          query: query.query,
          stage: query.stage,
          pipelineId: query.pipelineId,
          sort: query.sort,
        }),
      findById: (workspaceId, id) => repository.findById(db, workspaceId, id),
      create: (workspaceId, input, actorId) =>
        repository.create(db, workspaceId, input as unknown as CreateDealInput, actorId),
      update: (workspaceId, id, input, actorId) =>
        repository.update(db, workspaceId, id, input as unknown as UpdateDealInput, actorId),
      changeStage: (workspaceId, id, input, actorId) =>
        repository.changeStage(
          db,
          workspaceId,
          id,
          input as unknown as ChangeDealStageInput,
          actorId,
        ),
      close: (workspaceId, id, input, actorId) => {
        const stage = (input as { stage?: string }).stage
        if (stage !== "won" && stage !== "lost") throw new Error("deals.close: unknown stage")
        return repository.close(
          db,
          workspaceId,
          id,
          input as unknown as CloseDealInput & { stage: "won" | "lost" },
          actorId,
        )
      },
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

export function createRoutes(deps: DealsRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  // The connection resolves on the first request that needs it (and then the
  // request fails loudly instead of crashing route setup).
  let cached: DealsService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  app.get(
    "/",
    requireSession(),
    zValidator("query", dealQuerySchema, (result, c) => {
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
      return c.json({ data: found })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/",
    requireSession(),
    zValidator("json", createDealSchema, (result, c) => {
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
        const deal = await service().create(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: deal }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.patch(
    "/:id",
    requireSession(),
    zValidator("json", updateDealSchema, (result, c) => {
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
        const deal = await service().update(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: deal })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post(
    "/:id/stage",
    requireSession(),
    zValidator("json", changeDealStageSchema, (result, c) => {
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
        const deal = await service().changeStage(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: deal })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post(
    "/:id/win",
    requireSession(),
    zValidator("json", closeDealSchema, (result, c) => {
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
        const deal = await service().markWon(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: deal })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post(
    "/:id/lose",
    requireSession(),
    zValidator("json", closeDealSchema, (result, c) => {
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
        const deal = await service().markLost(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: deal })
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
      const deal = await service().restore(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: deal })
    } catch (err) {
      return mapError(c, err)
    }
  })

  return app
}

export const openApiPaths = {
  "/api/v1/deals": {
    get: {
      summary: "List deals (cursor pagination, search, stage filter, sorting)",
      operationId: "listDeals",
    },
    post: {
      summary: "Create a deal",
      operationId: "createDeal",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createDealSchema) } },
      },
    },
  },
  "/api/v1/deals/{id}": {
    get: { summary: "Get a deal", operationId: "getDeal" },
    patch: {
      summary: "Update a deal",
      operationId: "updateDeal",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateDealSchema) } },
      },
    },
    delete: { summary: "Soft-delete a deal", operationId: "deleteDeal" },
  },
  "/api/v1/deals/{id}/stage": {
    post: {
      summary: "Move a deal to another stage",
      operationId: "changeDealStage",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(changeDealStageSchema) } },
      },
    },
  },
  "/api/v1/deals/{id}/win": {
    post: {
      summary: "Close a deal as won",
      operationId: "markDealWon",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(closeDealSchema) } },
      },
    },
  },
  "/api/v1/deals/{id}/lose": {
    post: {
      summary: "Close a deal as lost",
      operationId: "markDealLost",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(closeDealSchema) } },
      },
    },
  },
  "/api/v1/deals/{id}/restore": {
    post: { summary: "Restore a soft-deleted deal", operationId: "restoreDeal" },
  },
}

export { dealEnvelope, dealListEnvelope }
