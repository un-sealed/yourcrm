import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  createPipelineSchema,
  createPipelinesService,
  createStageSchema,
  pipelineQuerySchema,
  pipelineSchema,
  pipelineStageSchema,
  reorderStagesSchema,
  updatePipelineSchema,
  updateStageSchema,
  type PipelinesService,
} from "@yourcrm/crm/src/pipelines"
import { getDb, writeAudit } from "@yourcrm/database"
import { createPipelinesRepository } from "@yourcrm/database/src/repositories/pipelines-repository"
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
 * Pipelines module (spec 10-pipelines, P0) — mirrors `people.ts`.
 *
 * Thin HTTP layer only: zod validation at the boundary, session from the
 * auth middleware, then straight into the domain service. No business logic
 * lives here. Denials surface as 403, unknown ids as 404, all in the shared
 * error envelope with the request id echoed.
 */

export const basePath = "/pipelines"

const pipelineEnvelope = z.object({ data: pipelineSchema.passthrough() })
const pipelineListEnvelope = paginatedEnvelopeSchema(pipelineSchema.passthrough())
const stageEnvelope = z.object({ data: pipelineStageSchema.passthrough() })
const stageListEnvelope = z.object({ data: z.array(pipelineStageSchema.passthrough()) })

export type PipelinesRouteDeps = {
  service?: PipelinesService
}

function defaultService(): PipelinesService {
  const db = getDb()
  const repository = createPipelinesRepository()
  return createPipelinesService({
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
      findWithStages: (workspaceId, id) => repository.findWithStages(db, workspaceId, id),
      create: (workspaceId, input, actorId) =>
        repository.create(
          db,
          workspaceId,
          input as unknown as Parameters<typeof repository.create>[2],
          actorId,
        ),
      createDefault: (workspaceId, actorId) => repository.createDefault(db, workspaceId, actorId),
      update: (workspaceId, id, input, actorId) =>
        repository.update(
          db,
          workspaceId,
          id,
          input as unknown as Parameters<typeof repository.update>[3],
          actorId,
        ),
      softDelete: async (workspaceId, id, actorId) => {
        await repository.softDelete(db, workspaceId, id, actorId)
      },
      restore: async (workspaceId, id) => {
        await repository.restore(db, workspaceId, id)
      },
      addStage: (workspaceId, pipelineId, input, actorId) =>
        repository.addStage(
          db,
          workspaceId,
          pipelineId,
          input as unknown as Parameters<typeof repository.addStage>[3],
          actorId,
        ),
      updateStage: (workspaceId, pipelineId, stageId, input, actorId) =>
        repository.updateStage(
          db,
          workspaceId,
          pipelineId,
          stageId,
          input as unknown as Parameters<typeof repository.updateStage>[4],
          actorId,
        ),
      removeStage: (workspaceId, pipelineId, stageId) =>
        repository.removeStage(db, workspaceId, pipelineId, stageId),
      reorderStages: (workspaceId, pipelineId, orderedIds, actorId) =>
        repository.reorderStages(db, workspaceId, pipelineId, orderedIds, actorId),
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

export function createRoutes(deps: PipelinesRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  // The connection resolves on the first request that needs it (and then the
  // request fails loudly instead of crashing route setup).
  let cached: PipelinesService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  app.get(
    "/",
    requireSession(),
    zValidator("query", pipelineQuerySchema, (result, c) => {
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

  app.post("/ensure-default", requireSession(), async (c) => {
    try {
      const found = await service().ensureDefault(serviceContextOf(c))
      return c.json({ data: { ...found.pipeline, stages: found.stages } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.get("/:id", requireSession(), async (c) => {
    try {
      const found = await service().get(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: { ...found.pipeline, stages: found.stages } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/",
    requireSession(),
    zValidator("json", createPipelineSchema, (result, c) => {
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
        return c.json({ data: { ...created.pipeline, stages: created.stages } }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.patch(
    "/:id",
    requireSession(),
    zValidator("json", updatePipelineSchema, (result, c) => {
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
        const pipeline = await service().update(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: pipeline })
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
      const pipeline = await service().restore(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: pipeline })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/:id/stages",
    requireSession(),
    zValidator("json", createStageSchema, (result, c) => {
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
        const stage = await service().addStage(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: stage }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.patch(
    "/:id/stages/:stageId",
    requireSession(),
    zValidator("json", updateStageSchema, (result, c) => {
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
        const stage = await service().updateStage(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.param("stageId"),
          c.req.valid("json"),
        )
        return c.json({ data: stage })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.delete("/:id/stages/:stageId", requireSession(), async (c) => {
    try {
      await service().removeStage(serviceContextOf(c), c.req.param("id"), c.req.param("stageId"))
      return c.json({ data: { deleted: true } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/:id/stages/reorder",
    requireSession(),
    zValidator("json", reorderStagesSchema, (result, c) => {
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
        const stages = await service().reorderStages(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: stages })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  return app
}

export const openApiPaths = {
  "/api/v1/pipelines": {
    get: {
      summary: "List pipelines (cursor pagination, search, status filter)",
      operationId: "listPipelines",
    },
    post: {
      summary: "Create a pipeline with ordered stages",
      operationId: "createPipeline",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createPipelineSchema) } },
      },
    },
  },
  "/api/v1/pipelines/ensure-default": {
    post: {
      summary: "Return the default sales pipeline, creating it if needed",
      operationId: "ensureDefaultPipeline",
    },
  },
  "/api/v1/pipelines/{id}": {
    get: { summary: "Get a pipeline with its stages", operationId: "getPipeline" },
    patch: {
      summary: "Update a pipeline",
      operationId: "updatePipeline",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updatePipelineSchema) } },
      },
    },
    delete: { summary: "Soft-delete a pipeline", operationId: "deletePipeline" },
  },
  "/api/v1/pipelines/{id}/restore": {
    post: { summary: "Restore a soft-deleted pipeline", operationId: "restorePipeline" },
  },
  "/api/v1/pipelines/{id}/stages": {
    post: {
      summary: "Add a stage to a pipeline",
      operationId: "addPipelineStage",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createStageSchema) } },
      },
    },
  },
  "/api/v1/pipelines/{id}/stages/{stageId}": {
    patch: {
      summary: "Update a pipeline stage",
      operationId: "updatePipelineStage",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateStageSchema) } },
      },
    },
    delete: { summary: "Remove a pipeline stage", operationId: "removePipelineStage" },
  },
  "/api/v1/pipelines/{id}/stages/reorder": {
    post: {
      summary: "Persist a drag-to-reorder stage order",
      operationId: "reorderPipelineStages",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(reorderStagesSchema) } },
      },
    },
  },
}

export { pipelineEnvelope, pipelineListEnvelope, stageEnvelope, stageListEnvelope }
