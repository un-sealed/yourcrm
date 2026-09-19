import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  createReportSchema,
  createReportsService,
  reportQuerySchema,
  reportResultSchema,
  reportSchema,
  runReportSchema,
  updateReportSchema,
  type ReportsService,
} from "@yourcrm/crm/src/reports"
import { getDb, writeAudit } from "@yourcrm/database"
import {
  createReportsRepository,
  describeReportObjects,
  type CreateReportInput,
  type ReportExecutionRequest,
  type ReportRowScope,
  type UpdateReportInput,
} from "@yourcrm/database/src/repositories/reports-repository"
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
 * Reports module (spec 26-reports, P0).
 *
 * Thin HTTP layer only: zod validation at the boundary, session from the
 * auth middleware, then straight into the domain service. No business
 * logic — in particular, the row-level permission scoping that makes
 * `POST /:id/run` safe lives in the service (`access.ts`), not here.
 *
 * Table output only: charts belong to the dashboards module.
 */

export const basePath = "/reports"

const reportEnvelope = z.object({ data: reportSchema.passthrough() })
const reportListEnvelope = paginatedEnvelopeSchema(reportSchema.passthrough())
const reportResultEnvelope = z.object({ data: reportResultSchema })

export type ReportsRouteDeps = {
  service?: ReportsService
}

function defaultService(): ReportsService {
  const db = getDb()
  const repository = createReportsRepository()
  return createReportsService({
    store: {
      list: (workspaceId, query, scope) =>
        repository.search(db, {
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          query: query.query,
          objectType: query.objectType,
          visibility: query.visibility,
          scope,
        }),
      findById: (workspaceId, id) => repository.findById(db, workspaceId, id),
      create: (workspaceId, input, actorId) =>
        repository.create(db, workspaceId, input as unknown as CreateReportInput, actorId),
      update: (workspaceId, id, input, actorId) =>
        repository.update(db, workspaceId, id, input as unknown as UpdateReportInput, actorId),
      softDelete: async (workspaceId, id, actorId) => {
        await repository.softDelete(db, workspaceId, id, actorId)
      },
      restore: async (workspaceId, id) => {
        await repository.restore(db, workspaceId, id)
      },
      execute: (workspaceId, request, scope) =>
        repository.execute(
          db,
          workspaceId,
          request as unknown as ReportExecutionRequest,
          scope as ReportRowScope,
        ),
      markRun: async (workspaceId, id, actorId) => {
        await repository.markRun(db, workspaceId, id, actorId)
      },
      describeObjects: () => describeReportObjects(),
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
  // A definition that references an unknown object/field/function never
  // reaches SQL — the repository rejects it. Surface it as a 400.
  if (err instanceof Error && (err as { code?: string }).code === "INVALID_REPORT") {
    return c.json(errorEnvelope("VALIDATION_ERROR", err.message, requestId), 400)
  }
  throw err
}

/** Shared 400 body for the zValidator hooks (hook contexts are generic). */
function invalidBody(c: Context, message: string, details: unknown) {
  return c.json(
    errorEnvelope("VALIDATION_ERROR", message, c.req.header("x-request-id") ?? undefined, details),
    400,
  )
}

export function createRoutes(deps: ReportsRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  let cached: ReportsService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  app.get(
    "/",
    requireSession(),
    zValidator("query", reportQuerySchema, (result, c) => {
      if (!result.success) {
        return invalidBody(c, "Invalid query parameters", result.error.flatten())
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

  // Registered before `/:id` so the catalogue is not read as a report id.
  app.get("/objects", requireSession(), (c) => {
    try {
      return c.json({ data: service().objects(serviceContextOf(c)) })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.get("/:id", requireSession(), async (c) => {
    try {
      const report = await service().get(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: report })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/",
    requireSession(),
    zValidator("json", createReportSchema, (result, c) => {
      if (!result.success) {
        return invalidBody(c, "Invalid request body", result.error.flatten())
      }
    }),
    async (c) => {
      try {
        const report = await service().create(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: report }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.patch(
    "/:id",
    requireSession(),
    zValidator("json", updateReportSchema, (result, c) => {
      if (!result.success) {
        return invalidBody(c, "Invalid request body", result.error.flatten())
      }
    }),
    async (c) => {
      try {
        const report = await service().update(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: report })
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
      const report = await service().restore(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: report })
    } catch (err) {
      return mapError(c, err)
    }
  })

  /**
   * Execute a saved report. Rows are filtered by the caller's permissions
   * inside the domain service, so two actors can get different results
   * from the same definition.
   */
  app.post(
    "/:id/run",
    requireSession(),
    zValidator("json", runReportSchema.optional(), (result, c) => {
      if (!result.success) {
        return invalidBody(c, "Invalid run options", result.error.flatten())
      }
    }),
    async (c) => {
      try {
        const { result } = await service().run(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json") ?? {},
        )
        return c.json({ data: result })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  return app
}

export const openApiPaths = {
  "/api/v1/reports": {
    get: {
      summary: "List saved reports (cursor pagination, search, object filter)",
      operationId: "listReports",
    },
    post: {
      summary: "Create a report definition",
      operationId: "createReport",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createReportSchema) } },
      },
    },
  },
  "/api/v1/reports/objects": {
    get: {
      summary: "List reportable objects and their fields",
      operationId: "listReportObjects",
    },
  },
  "/api/v1/reports/{id}": {
    get: { summary: "Get a report definition", operationId: "getReport" },
    patch: {
      summary: "Update a report definition",
      operationId: "updateReport",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateReportSchema) } },
      },
    },
    delete: { summary: "Soft-delete a report", operationId: "deleteReport" },
  },
  "/api/v1/reports/{id}/restore": {
    post: { summary: "Restore a soft-deleted report", operationId: "restoreReport" },
  },
  "/api/v1/reports/{id}/run": {
    post: {
      summary: "Run a report; rows are filtered by the caller's permissions",
      operationId: "runReport",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(runReportSchema) } },
      },
    },
  },
}

export { reportEnvelope, reportListEnvelope, reportResultEnvelope }
