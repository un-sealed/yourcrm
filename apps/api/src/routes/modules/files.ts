import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import { getEnv } from "../../env"
import {
  createFilesService,
  createFileSchema,
  fileQuerySchema,
  fileSchema,
  updateFileSchema,
  uploadUrlRequestSchema,
  type FilesService,
} from "@yourcrm/crm/src/files"
import { getDb, writeAudit } from "@yourcrm/database"
import { createFilesRepository } from "@yourcrm/database/src/repositories/files-repository"
import type {
  CreateFileInput,
  UpdateFileInput,
} from "@yourcrm/database/src/repositories/files-repository"
import { getEventBus } from "@yourcrm/events"
import { PermissionDeniedError } from "@yourcrm/permissions"
import { StorageService, storageConfigFromEnv } from "@yourcrm/storage"
import { errorEnvelope, paginatedEnvelopeSchema } from "@yourcrm/validation"
import { Hono } from "hono"
import type { Context } from "hono"
import { z } from "zod"
import type { AppEnv } from "../../hono-env"
import { requireSession } from "../../middleware/auth"
import { zodToJsonSchema } from "../../openapi/zod-to-json-schema"

/**
 * Files module (spec 29-files, P0) — mirrors the people reference module.
 *
 * Thin HTTP layer only: zod validation at the boundary, session from the
 * auth middleware, then straight into the domain service. No business logic
 * lives here. Denials surface as 403, unknown ids as 404, oversize uploads
 * as 413, all in the shared error envelope with the request id echoed.
 *
 * Bytes never flow through these handlers: `POST /upload-url` mints a
 * presigned PUT the browser uses against S3/MinIO directly, `GET
 * /:id/download-url` mints a presigned GET, and `POST /` stores metadata
 * only after the bytes land.
 */

export const basePath = "/files"

const fileEnvelope = z.object({ data: fileSchema.passthrough() })
const fileListEnvelope = paginatedEnvelopeSchema(fileSchema.passthrough())

export type FilesRouteDeps = {
  service?: FilesService
}

/**
 * Presigned PUT is not in `@yourcrm/storage` yet (only `presignedGet`), so
 * the default upload signer fails loudly with 501 instead of proxying bytes
 * or inventing a parallel signer. Tests inject a fake `UrlSigner`; production
 * binds the real one the moment storage grows a presigned-PUT method.
 */
export class UploadSigningUnavailableError extends Error {
  readonly code = "UPLOAD_SIGNING_UNAVAILABLE"
  constructor() {
    super("files.upload: presigned upload URLs are not configured (storage has no presigned PUT)")
    this.name = "UploadSigningUnavailableError"
  }
}

function defaultService(): FilesService {
  const db = getDb()
  const repository = createFilesRepository()
  const storage = () => new StorageService(storageConfigFromEnv(getEnv()))
  return createFilesService({
    store: {
      list: (workspaceId, query) =>
        repository.search(db, {
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          query: query.query,
          mimeType: query.mimeType,
          subjectType: query.subjectType,
        }),
      findById: (workspaceId, id) => repository.findById(db, workspaceId, id),
      create: (workspaceId, input, actorId) =>
        repository.create(db, workspaceId, input as unknown as CreateFileInput, actorId),
      update: (workspaceId, id, input, actorId) =>
        repository.update(db, workspaceId, id, input as unknown as UpdateFileInput, actorId),
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
    urls: {
      signUpload: async () => {
        throw new UploadSigningUnavailableError()
      },
      signDownload: (key) => storage().presignedGet(key),
    },
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
  if (err instanceof Error && (err as { code?: string }).code === "FILE_TOO_LARGE") {
    return c.json(errorEnvelope("FILE_TOO_LARGE", err.message, requestId), 413)
  }
  if (err instanceof UploadSigningUnavailableError) {
    return c.json(errorEnvelope("UPLOAD_SIGNING_UNAVAILABLE", err.message, requestId), 501)
  }
  throw err
}

export function createRoutes(deps: FilesRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  // The connection resolves on the first request that needs it (and then the
  // request fails loudly instead of crashing route setup).
  let cached: FilesService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  app.get(
    "/",
    requireSession(),
    zValidator("query", fileQuerySchema, (result, c) => {
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

  app.post(
    "/upload-url",
    requireSession(),
    zValidator("json", uploadUrlRequestSchema, (result, c) => {
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
        const result = await service().getUploadUrl(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: result }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/:id/download-url", requireSession(), async (c) => {
    try {
      const result = await service().getDownloadUrl(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: result })
    } catch (err) {
      return mapError(c, err)
    }
  })

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
    zValidator("json", createFileSchema, (result, c) => {
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
        const file = await service().create(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: file }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.patch(
    "/:id",
    requireSession(),
    zValidator("json", updateFileSchema, (result, c) => {
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
        const file = await service().update(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: file })
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
      const file = await service().restore(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: file })
    } catch (err) {
      return mapError(c, err)
    }
  })

  return app
}

export const openApiPaths = {
  "/api/v1/files": {
    get: {
      summary: "List files (cursor pagination, search, mime-type/subject filters)",
      operationId: "listFiles",
    },
    post: {
      summary: "Create a file metadata record (bytes upload separately via presigned URL)",
      operationId: "createFile",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createFileSchema) } },
      },
    },
  },
  "/api/v1/files/upload-url": {
    post: {
      summary: "Mint a presigned upload URL (PUT bytes to S3/MinIO directly)",
      operationId: "getFileUploadUrl",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(uploadUrlRequestSchema) } },
      },
    },
  },
  "/api/v1/files/{id}": {
    get: { summary: "Get a file metadata record", operationId: "getFile" },
    patch: {
      summary: "Update a file metadata record",
      operationId: "updateFile",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateFileSchema) } },
      },
    },
    delete: { summary: "Soft-delete a file", operationId: "deleteFile" },
  },
  "/api/v1/files/{id}/download-url": {
    get: { summary: "Mint a presigned download URL", operationId: "getFileDownloadUrl" },
  },
  "/api/v1/files/{id}/restore": {
    post: { summary: "Restore a soft-deleted file", operationId: "restoreFile" },
  },
}

export { fileEnvelope, fileListEnvelope }
