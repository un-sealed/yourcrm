import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  createDashboardSchema,
  createDashboardsService,
  createWidgetSchema,
  dashboardQuerySchema,
  dashboardSchema,
  dashboardWidgetSchema,
  repositionWidgetSchema,
  updateDashboardSchema,
  updateWidgetSchema,
  type DashboardsService,
} from "@yourcrm/crm/src/dashboards"
import { getDb, writeAudit } from "@yourcrm/database"
import { createDashboardsRepository } from "@yourcrm/database/src/repositories/dashboards-repository"
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
 * Dashboards module (spec 27-dashboards, P0) — mirrors `people.ts` /
 * `pipelines.ts`.
 *
 * Thin HTTP layer only: zod validation at the boundary, session from the
 * auth middleware, then straight into the domain service. No business logic
 * lives here. Denials surface as 403, unknown ids as 404, all in the shared
 * error envelope with the request id echoed.
 */

export const basePath = "/dashboards"

const dashboardEnvelope = z.object({ data: dashboardSchema.passthrough() })
const dashboardListEnvelope = paginatedEnvelopeSchema(dashboardSchema.passthrough())
const widgetEnvelope = z.object({ data: dashboardWidgetSchema.passthrough() })
const widgetListEnvelope = z.object({ data: z.array(dashboardWidgetSchema.passthrough()) })

export type DashboardsRouteDeps = {
  service?: DashboardsService
}

function defaultService(): DashboardsService {
  const db = getDb()
  const repository = createDashboardsRepository()
  return createDashboardsService({
    store: {
      list: (workspaceId, query) =>
        repository.search(db, {
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          query: query.query,
        }),
      findById: (workspaceId, id) => repository.findById(db, workspaceId, id),
      findWithWidgets: (workspaceId, id) => repository.findWithWidgets(db, workspaceId, id),
      create: (workspaceId, input, actorId) =>
        repository.create(
          db,
          workspaceId,
          input as unknown as Parameters<typeof repository.create>[2],
          actorId,
        ),
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
      addWidget: (workspaceId, dashboardId, input, actorId) =>
        repository.addWidget(
          db,
          workspaceId,
          dashboardId,
          input as unknown as Parameters<typeof repository.addWidget>[3],
          actorId,
        ),
      updateWidget: (workspaceId, dashboardId, widgetId, input, actorId) =>
        repository.updateWidget(
          db,
          workspaceId,
          dashboardId,
          widgetId,
          input as unknown as Parameters<typeof repository.updateWidget>[4],
          actorId,
        ),
      removeWidget: (workspaceId, dashboardId, widgetId) =>
        repository.removeWidget(db, workspaceId, dashboardId, widgetId),
      repositionWidget: (workspaceId, dashboardId, widgetId, input, actorId) =>
        repository.repositionWidget(
          db,
          workspaceId,
          dashboardId,
          widgetId,
          input as unknown as Parameters<typeof repository.repositionWidget>[4],
          actorId,
        ),
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

export function createRoutes(deps: DashboardsRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  // The connection resolves on the first request that needs it (and then the
  // request fails loudly instead of crashing route setup).
  let cached: DashboardsService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  app.get(
    "/",
    requireSession(),
    zValidator("query", dashboardQuerySchema, (result, c) => {
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
      return c.json({ data: { ...found.dashboard, widgets: found.widgets } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/",
    requireSession(),
    zValidator("json", createDashboardSchema, (result, c) => {
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
        return c.json({ data: { ...created.dashboard, widgets: created.widgets } }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.patch(
    "/:id",
    requireSession(),
    zValidator("json", updateDashboardSchema, (result, c) => {
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
        const dashboard = await service().update(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: dashboard })
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
      const dashboard = await service().restore(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: dashboard })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/:id/widgets",
    requireSession(),
    zValidator("json", createWidgetSchema, (result, c) => {
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
        const widget = await service().addWidget(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: widget }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.patch(
    "/:id/widgets/:widgetId",
    requireSession(),
    zValidator("json", updateWidgetSchema, (result, c) => {
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
        const widget = await service().updateWidget(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.param("widgetId"),
          c.req.valid("json"),
        )
        return c.json({ data: widget })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.delete("/:id/widgets/:widgetId", requireSession(), async (c) => {
    try {
      await service().removeWidget(serviceContextOf(c), c.req.param("id"), c.req.param("widgetId"))
      return c.json({ data: { deleted: true } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/:id/widgets/:widgetId/reposition",
    requireSession(),
    zValidator("json", repositionWidgetSchema, (result, c) => {
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
        const widget = await service().repositionWidget(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.param("widgetId"),
          c.req.valid("json"),
        )
        return c.json({ data: widget })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  return app
}

export const openApiPaths = {
  "/api/v1/dashboards": {
    get: {
      summary: "List dashboards (cursor pagination, search)",
      operationId: "listDashboards",
    },
    post: {
      summary: "Create a dashboard with an initial widget layout",
      operationId: "createDashboard",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createDashboardSchema) } },
      },
    },
  },
  "/api/v1/dashboards/{id}": {
    get: { summary: "Get a dashboard with its widgets", operationId: "getDashboard" },
    patch: {
      summary: "Update a dashboard",
      operationId: "updateDashboard",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateDashboardSchema) } },
      },
    },
    delete: { summary: "Soft-delete a dashboard", operationId: "deleteDashboard" },
  },
  "/api/v1/dashboards/{id}/restore": {
    post: { summary: "Restore a soft-deleted dashboard", operationId: "restoreDashboard" },
  },
  "/api/v1/dashboards/{id}/widgets": {
    post: {
      summary: "Add a widget to a dashboard",
      operationId: "addDashboardWidget",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createWidgetSchema) } },
      },
    },
  },
  "/api/v1/dashboards/{id}/widgets/{widgetId}": {
    patch: {
      summary: "Update a dashboard widget",
      operationId: "updateDashboardWidget",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateWidgetSchema) } },
      },
    },
    delete: { summary: "Remove a dashboard widget", operationId: "removeDashboardWidget" },
  },
  "/api/v1/dashboards/{id}/widgets/{widgetId}/reposition": {
    post: {
      summary: "Persist a drag-to-reposition result for a widget",
      operationId: "repositionDashboardWidget",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(repositionWidgetSchema) } },
      },
    },
  },
}

export { dashboardEnvelope, dashboardListEnvelope, widgetEnvelope, widgetListEnvelope }
