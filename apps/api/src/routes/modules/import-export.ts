import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  completeImportSchema,
  createExportJobSchema,
  createImportExportService,
  createImportJobSchema,
  dryRunImportSchema,
  exportJobQuerySchema,
  exportJobSchema,
  importJobQuerySchema,
  importJobSchema,
  updateExportJobSchema,
  updateImportJobSchema,
  type ImportExportService,
} from "@yourcrm/crm/src/import-export"
import { getDb, writeAudit } from "@yourcrm/database"
import {
  createExportJobsRepository,
  createImportJobsRepository,
} from "@yourcrm/database/src/repositories/import-export-repository"
import { getEventBus } from "@yourcrm/events"
import { PermissionDeniedError } from "@yourcrm/permissions"
import { errorEnvelope, paginatedEnvelopeSchema } from "@yourcrm/validation"
import { Hono } from "hono"
import type { Context, Env } from "hono"
import { z } from "zod"
import type { AppEnv } from "../../hono-env"
import { requireSession } from "../../middleware/auth"
import { zodToJsonSchema } from "../../openapi/zod-to-json-schema"

/**
 * Import / Export module (spec 30-import-export, P0 CSV only).
 *
 * Thin HTTP layer only: zod validation at the boundary, session from the
 * auth middleware, then straight into the domain service. No business logic
 * lives here. Denials surface as 403, unknown ids as 404, all in the shared
 * error envelope with the request id echoed.
 */

export const basePath = "/import-export"

const importEnvelope = z.object({ data: importJobSchema.passthrough() })
const importListEnvelope = paginatedEnvelopeSchema(importJobSchema.passthrough())
const exportEnvelope = z.object({ data: exportJobSchema.passthrough() })
const exportListEnvelope = paginatedEnvelopeSchema(exportJobSchema.passthrough())
const dryRunEnvelope = z.object({
  data: z.object({
    totalRows: z.number(),
    validRows: z.number(),
    invalidRows: z.number(),
    missingColumns: z.array(z.string()),
    errors: z.array(
      z.object({
        row: z.number(),
        column: z.string().nullable(),
        message: z.string(),
      }),
    ),
  }),
})

export type ImportExportRouteDeps = {
  service?: ImportExportService
}

function defaultService(): ImportExportService {
  const db = getDb()
  const imports = createImportJobsRepository()
  const exports = createExportJobsRepository()
  return createImportExportService({
    store: {
      listImports: (workspaceId, query) =>
        imports.search(db, {
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          query: query.query,
          status: query.status,
          objectType: query.objectType,
        }),
      findImportById: (workspaceId, id) => imports.findById(db, workspaceId, id),
      createImport: (workspaceId, input, actorId) =>
        imports.create(
          db,
          workspaceId,
          input as unknown as Parameters<typeof imports.create>[2],
          actorId,
        ),
      updateImport: (workspaceId, id, input, actorId) =>
        imports.update(
          db,
          workspaceId,
          id,
          input as unknown as Parameters<typeof imports.update>[3],
          actorId,
        ),
      softDeleteImport: async (workspaceId, id, actorId) => {
        await imports.softDelete(db, workspaceId, id, actorId)
      },
      restoreImport: async (workspaceId, id) => {
        await imports.restore(db, workspaceId, id)
      },
      listExports: (workspaceId, query) =>
        exports.search(db, {
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          query: query.query,
          status: query.status,
          objectType: query.objectType,
        }),
      findExportById: (workspaceId, id) => exports.findById(db, workspaceId, id),
      createExport: (workspaceId, input, actorId) =>
        exports.create(
          db,
          workspaceId,
          input as unknown as Parameters<typeof exports.create>[2],
          actorId,
        ),
      updateExport: (workspaceId, id, input, actorId) =>
        exports.update(
          db,
          workspaceId,
          id,
          input as unknown as Parameters<typeof exports.update>[3],
          actorId,
        ),
      softDeleteExport: async (workspaceId, id, actorId) => {
        await exports.softDelete(db, workspaceId, id, actorId)
      },
      restoreExport: async (workspaceId, id) => {
        await exports.restore(db, workspaceId, id)
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

function invalidBody(c: Context<Env>, result: { error: { flatten: () => unknown } }) {
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

function invalidQuery(c: Context<Env>, result: { error: { flatten: () => unknown } }) {
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

export function createRoutes(deps: ImportExportRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  // The connection resolves on the first request that needs it (and then the
  // request fails loudly instead of crashing route setup).
  let cached: ImportExportService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  app.get(
    "/imports",
    requireSession(),
    zValidator("query", importJobQuerySchema, (result, c) => {
      if (!result.success) return invalidQuery(c, result)
    }),
    async (c) => {
      try {
        const result = await service().listImports(serviceContextOf(c), c.req.valid("query"))
        return c.json(result)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/imports/:id", requireSession(), async (c) => {
    try {
      const job = await service().getImport(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: job })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/imports",
    requireSession(),
    zValidator("json", createImportJobSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result)
    }),
    async (c) => {
      try {
        const job = await service().createImport(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: job }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.patch(
    "/imports/:id",
    requireSession(),
    zValidator("json", updateImportJobSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result)
    }),
    async (c) => {
      try {
        const job = await service().updateImport(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: job })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.delete("/imports/:id", requireSession(), async (c) => {
    try {
      await service().softDeleteImport(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: { deleted: true } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post("/imports/:id/restore", requireSession(), async (c) => {
    try {
      const job = await service().restoreImport(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: job })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/imports/:id/dry-run",
    requireSession(),
    zValidator("json", dryRunImportSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result)
    }),
    async (c) => {
      try {
        const preview = await service().dryRunImport(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: preview })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post(
    "/imports/:id/complete",
    requireSession(),
    zValidator("json", completeImportSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result)
    }),
    async (c) => {
      try {
        const job = await service().completeImport(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: job })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get(
    "/exports",
    requireSession(),
    zValidator("query", exportJobQuerySchema, (result, c) => {
      if (!result.success) return invalidQuery(c, result)
    }),
    async (c) => {
      try {
        const result = await service().listExports(serviceContextOf(c), c.req.valid("query"))
        return c.json(result)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/exports/:id", requireSession(), async (c) => {
    try {
      const job = await service().getExport(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: job })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/exports",
    requireSession(),
    zValidator("json", createExportJobSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result)
    }),
    async (c) => {
      try {
        const job = await service().createExport(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: job }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.patch(
    "/exports/:id",
    requireSession(),
    zValidator("json", updateExportJobSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result)
    }),
    async (c) => {
      try {
        const job = await service().updateExport(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: job })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.delete("/exports/:id", requireSession(), async (c) => {
    try {
      await service().softDeleteExport(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: { deleted: true } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post("/exports/:id/restore", requireSession(), async (c) => {
    try {
      const job = await service().restoreExport(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: job })
    } catch (err) {
      return mapError(c, err)
    }
  })

  return app
}

export const openApiPaths = {
  "/api/v1/import-export/imports": {
    get: {
      summary: "List import jobs (cursor pagination, search, status filter)",
      operationId: "listImportJobs",
    },
    post: {
      summary: "Create an import job (CSV, column mapping, background execution)",
      operationId: "createImportJob",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createImportJobSchema) } },
      },
    },
  },
  "/api/v1/import-export/imports/{id}": {
    get: { summary: "Get an import job", operationId: "getImportJob" },
    patch: {
      summary: "Update an import job",
      operationId: "updateImportJob",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateImportJobSchema) } },
      },
    },
    delete: { summary: "Soft-delete an import job", operationId: "deleteImportJob" },
  },
  "/api/v1/import-export/imports/{id}/restore": {
    post: { summary: "Restore a soft-deleted import job", operationId: "restoreImportJob" },
  },
  "/api/v1/import-export/imports/{id}/dry-run": {
    post: {
      summary: "Dry-run validation preview for an import job",
      operationId: "dryRunImportJob",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(dryRunImportSchema) } },
      },
    },
  },
  "/api/v1/import-export/imports/{id}/complete": {
    post: {
      summary: "Record background execution results for an import job",
      operationId: "completeImportJob",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(completeImportSchema) } },
      },
    },
  },
  "/api/v1/import-export/exports": {
    get: {
      summary: "List export jobs (cursor pagination, search, status filter)",
      operationId: "listExportJobs",
    },
    post: {
      summary: "Create an export job (permission-aware, audited)",
      operationId: "createExportJob",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createExportJobSchema) } },
      },
    },
  },
  "/api/v1/import-export/exports/{id}": {
    get: { summary: "Get an export job", operationId: "getExportJob" },
    patch: {
      summary: "Update an export job",
      operationId: "updateExportJob",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateExportJobSchema) } },
      },
    },
    delete: { summary: "Soft-delete an export job", operationId: "deleteExportJob" },
  },
  "/api/v1/import-export/exports/{id}/restore": {
    post: { summary: "Restore a soft-deleted export job", operationId: "restoreExportJob" },
  },
}

export { dryRunEnvelope, exportEnvelope, exportListEnvelope, importEnvelope, importListEnvelope }
