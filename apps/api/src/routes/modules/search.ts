import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  createSearchService,
  searchDocumentRefSchema,
  searchDocumentSchema,
  searchHitSchema,
  searchIndexDocumentSchema,
  searchQuerySchema,
  type SearchService,
} from "@yourcrm/crm/src/search"
import { getDb, writeAudit } from "@yourcrm/database"
import { createSearchRepository } from "@yourcrm/database/src/repositories/search-repository"
import type { UpsertSearchDocumentInput } from "@yourcrm/database/src/repositories/search-repository"
import { PermissionDeniedError } from "@yourcrm/permissions"
import { errorEnvelope, paginatedEnvelopeSchema } from "@yourcrm/validation"
import { Hono } from "hono"
import type { Context } from "hono"
import { z } from "zod"
import type { AppEnv } from "../../hono-env"
import { requireSession } from "../../middleware/auth"
import { zodToJsonSchema } from "../../openapi/zod-to-json-schema"

/**
 * Global search module (spec 28-search, P0).
 *
 * Thin HTTP layer only: zod validation at the boundary, session from the auth
 * middleware, then straight into the domain service. Permission filtering of
 * results happens in the service (`packages/crm/src/search/policy.ts`), never
 * here — UI hiding is not a security boundary and neither is a route handler.
 */

export const basePath = "/search"

const searchHitListEnvelope = paginatedEnvelopeSchema(searchHitSchema.passthrough())
const searchDocumentEnvelope = z.object({ data: searchDocumentSchema.passthrough() })

export type SearchRouteDeps = {
  service?: SearchService
}

function defaultService(): SearchService {
  const db = getDb()
  const repository = createSearchRepository()
  return createSearchService({
    store: {
      query: (workspaceId, query) =>
        repository.query(db, {
          workspaceId,
          query: query.query,
          objects: query.objects,
          limit: query.limit,
          cursor: query.cursor,
          actorId: query.actorId,
          includePrivate: query.includePrivate,
        }),
      upsert: (workspaceId, input, actorId) =>
        repository.upsert(db, workspaceId, input as unknown as UpsertSearchDocumentInput, actorId),
      removeByRecord: (workspaceId, objectType, recordId, actorId) =>
        repository.removeByRecord(db, workspaceId, objectType, recordId, actorId),
      findByRecord: (workspaceId, objectType, recordId) =>
        repository.findByRecord(db, workspaceId, objectType, recordId),
    },
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "user" })
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
  throw err
}

/** Shared 400 body. Takes the request id rather than a context so the zod
 * validator hook (a bare `Context<Env>`) and the handlers can both use it. */
function invalidBody(requestId: string | undefined, message: string, details: unknown) {
  return errorEnvelope("VALIDATION_ERROR", message, requestId, details)
}

export function createRoutes(deps: SearchRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  // The connection resolves on the first request that needs it.
  let cached: SearchService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  app.get(
    "/",
    requireSession(),
    zValidator("query", searchQuerySchema, (result, c) => {
      if (!result.success) {
        return c.json(
          invalidBody(
            c.req.header("x-request-id") ?? undefined,
            "Invalid query parameters",
            result.error.flatten(),
          ),
          400,
        )
      }
    }),
    async (c) => {
      try {
        const result = await service().search(serviceContextOf(c), c.req.valid("query"))
        return c.json(result)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post(
    "/index",
    requireSession(),
    zValidator("json", searchIndexDocumentSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          invalidBody(
            c.req.header("x-request-id") ?? undefined,
            "Invalid request body",
            result.error.flatten(),
          ),
          400,
        )
      }
    }),
    async (c) => {
      try {
        const document = await service().indexRecord(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: document }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/index/:objectType/:recordId", requireSession(), async (c) => {
    const ref = searchDocumentRefSchema.safeParse({
      objectType: c.req.param("objectType"),
      recordId: c.req.param("recordId"),
    })
    if (!ref.success) {
      return c.json(
        invalidBody(
          c.get("requestId") as string | undefined,
          "Invalid record reference",
          ref.error.flatten(),
        ),
        400,
      )
    }
    try {
      const document = await service().getIndexed(serviceContextOf(c), ref.data)
      return c.json({ data: document })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.delete("/index/:objectType/:recordId", requireSession(), async (c) => {
    const ref = searchDocumentRefSchema.safeParse({
      objectType: c.req.param("objectType"),
      recordId: c.req.param("recordId"),
    })
    if (!ref.success) {
      return c.json(
        invalidBody(
          c.get("requestId") as string | undefined,
          "Invalid record reference",
          ref.error.flatten(),
        ),
        400,
      )
    }
    try {
      const result = await service().removeRecord(serviceContextOf(c), ref.data)
      return c.json({ data: result })
    } catch (err) {
      return mapError(c, err)
    }
  })

  return app
}

export const openApiPaths = {
  "/api/v1/search": {
    get: {
      summary: "Full-text search across indexed records, filtered by permissions",
      operationId: "search",
    },
  },
  "/api/v1/search/index": {
    post: {
      summary: "Index or re-index one record",
      operationId: "indexSearchRecord",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(searchIndexDocumentSchema) } },
      },
    },
  },
  "/api/v1/search/index/{objectType}/{recordId}": {
    get: { summary: "Get the indexed document for a record", operationId: "getSearchRecord" },
    delete: { summary: "Remove a record from the index", operationId: "deleteSearchRecord" },
  },
}

export { searchDocumentEnvelope, searchHitListEnvelope }
