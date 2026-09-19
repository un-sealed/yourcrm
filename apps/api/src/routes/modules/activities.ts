import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  createActivitiesService,
  createActivitySchema,
  activityQuerySchema,
  activitySchema,
  activityTimelineQuerySchema,
  updateActivitySchema,
  type ActivitiesService,
} from "@yourcrm/crm/src/activities"
import { getDb, writeAudit } from "@yourcrm/database"
import { createActivitiesRepository } from "@yourcrm/database/src/repositories/activities-repository"
import type {
  CreateActivityInput,
  UpdateActivityInput,
} from "@yourcrm/database/src/repositories/activities-repository"
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
 * Activities module (spec 11-activities, P0) — mirrors the people reference.
 *
 * Thin HTTP layer only: zod validation at the boundary, session from the
 * auth middleware, then straight into the domain service. No business logic
 * lives here. Denials surface as 403, unknown ids as 404, all in the shared
 * error envelope with the request id echoed.
 */

export const basePath = "/activities"

const activityEnvelope = z.object({ data: activitySchema.passthrough() })
const activityListEnvelope = paginatedEnvelopeSchema(activitySchema.passthrough())

export type ActivitiesRouteDeps = {
  service?: ActivitiesService
}

function defaultService(): ActivitiesService {
  const db = getDb()
  const repository = createActivitiesRepository()
  return createActivitiesService({
    store: {
      list: (workspaceId, query) =>
        repository.search(db, {
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          query: query.query,
          type: query.type,
          status: query.status,
          subjectType: query.subjectType,
          subjectId: query.subjectId,
        }),
      timeline: (workspaceId, query) =>
        repository.timeline(db, {
          workspaceId,
          subjectType: query.subjectType,
          subjectId: query.subjectId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
        }),
      findById: (workspaceId, id) => repository.findById(db, workspaceId, id),
      create: (workspaceId, input, actorId) =>
        repository.create(db, workspaceId, input as unknown as CreateActivityInput, actorId),
      update: (workspaceId, id, input, actorId) =>
        repository.update(db, workspaceId, id, input as unknown as UpdateActivityInput, actorId),
      complete: (workspaceId, id, actorId) => repository.complete(db, workspaceId, id, actorId),
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

export function createRoutes(deps: ActivitiesRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  // The connection resolves on the first request that needs it (and then the
  // request fails loudly instead of crashing route setup).
  let cached: ActivitiesService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  app.get(
    "/",
    requireSession(),
    zValidator("query", activityQuerySchema, (result, c) => {
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

  app.get(
    "/timeline",
    requireSession(),
    zValidator("query", activityTimelineQuerySchema, (result, c) => {
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
        const result = await service().timeline(serviceContextOf(c), c.req.valid("query"))
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
    zValidator("json", createActivitySchema, (result, c) => {
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
        const activity = await service().create(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: activity }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.patch(
    "/:id",
    requireSession(),
    zValidator("json", updateActivitySchema, (result, c) => {
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
        const activity = await service().update(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: activity })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post("/:id/complete", requireSession(), async (c) => {
    try {
      const activity = await service().complete(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: activity })
    } catch (err) {
      return mapError(c, err)
    }
  })

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
      const activity = await service().restore(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: activity })
    } catch (err) {
      return mapError(c, err)
    }
  })

  return app
}

export const openApiPaths = {
  "/api/v1/activities": {
    get: {
      summary: "List activities (cursor pagination, search, type/status/subject filters)",
      operationId: "listActivities",
    },
    post: {
      summary: "Create an activity",
      operationId: "createActivity",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createActivitySchema) } },
      },
    },
  },
  "/api/v1/activities/timeline": {
    get: {
      summary: "Reusable timeline feed for one subject record",
      operationId: "activityTimeline",
    },
  },
  "/api/v1/activities/{id}": {
    get: { summary: "Get an activity", operationId: "getActivity" },
    patch: {
      summary: "Update an activity",
      operationId: "updateActivity",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateActivitySchema) } },
      },
    },
    delete: { summary: "Soft-delete an activity", operationId: "deleteActivity" },
  },
  "/api/v1/activities/{id}/complete": {
    post: { summary: "Mark an activity completed", operationId: "completeActivity" },
  },
  "/api/v1/activities/{id}/restore": {
    post: { summary: "Restore a soft-deleted activity", operationId: "restoreActivity" },
  },
}

export { activityEnvelope, activityListEnvelope }
