import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  createKbArticleSchema,
  createKbCategorySchema,
  createKnowledgeBaseService,
  kbArticleQuerySchema,
  kbArticleSchema,
  kbCategorySchema,
  updateKbArticleSchema,
  updateKbCategorySchema,
  type KnowledgeBaseService,
} from "@yourcrm/crm/src/knowledge-base"
import { createSearchService } from "@yourcrm/crm/src/search"
import { getDb, writeAudit } from "@yourcrm/database"
import {
  createKbArticleRepository,
  createKbCategoryRepository,
} from "@yourcrm/database/src/repositories/knowledge-base-repository"
import type {
  CreateKbArticleInput,
  CreateKbCategoryInput,
  UpdateKbArticleInput,
  UpdateKbCategoryInput,
} from "@yourcrm/database/src/repositories/knowledge-base-repository"
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
 * Knowledge Base module (spec 22-knowledge-base, P0). Thin HTTP layer only:
 * zod validation at the boundary, session from the auth middleware, then
 * straight into the domain service — see `packages/crm/src/knowledge-base`
 * for the actual rules (draft visibility, slug uniqueness, search wiring).
 */

export const basePath = "/knowledge-base"

const categoryEnvelope = z.object({ data: kbCategorySchema.passthrough() })
const categoryListEnvelope = z.object({ data: z.array(kbCategorySchema.passthrough()) })
const articleEnvelope = z.object({ data: kbArticleSchema.passthrough() })
const articleListEnvelope = paginatedEnvelopeSchema(kbArticleSchema.passthrough())

export type KnowledgeBaseRouteDeps = {
  service?: KnowledgeBaseService
}

function defaultService(): KnowledgeBaseService {
  const db = getDb()
  const articleRepo = createKbArticleRepository()
  const categoryRepo = createKbCategoryRepository()
  // Push published articles into the shared `search_index` through the real
  // search domain service (packages/crm/src/search) rather than growing a
  // second full-text implementation — see the module's KbSearchIndexPort.
  const searchRepo = createSearchRepository()
  const searchService = createSearchService({
    store: {
      query: (workspaceId, query) =>
        searchRepo.query(db, {
          workspaceId,
          query: query.query,
          objects: query.objects,
          limit: query.limit,
          cursor: query.cursor,
          actorId: query.actorId,
          includePrivate: query.includePrivate,
        }),
      upsert: (workspaceId, input, actorId) =>
        searchRepo.upsert(db, workspaceId, input as unknown as UpsertSearchDocumentInput, actorId),
      removeByRecord: (workspaceId, objectType, recordId, actorId) =>
        searchRepo.removeByRecord(db, workspaceId, objectType, recordId, actorId),
      findByRecord: (workspaceId, objectType, recordId) =>
        searchRepo.findByRecord(db, workspaceId, objectType, recordId),
    },
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "user" })
    },
  })

  return createKnowledgeBaseService({
    articles: {
      list: (workspaceId, query) =>
        articleRepo.search(db, {
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          query: query.query,
          status: query.status,
          categoryId: query.categoryId,
          includeUnpublished: query.includeUnpublished,
        }),
      findById: (workspaceId, id) => articleRepo.findById(db, workspaceId, id),
      findBySlug: (workspaceId, slug) => articleRepo.findBySlug(db, workspaceId, slug),
      create: (workspaceId, input, actorId) =>
        articleRepo.create(db, workspaceId, input as unknown as CreateKbArticleInput, actorId),
      update: (workspaceId, id, input, actorId) =>
        articleRepo.update(db, workspaceId, id, input as unknown as UpdateKbArticleInput, actorId),
      setStatus: (workspaceId, id, status, actorId) =>
        articleRepo.setStatus(db, workspaceId, id, status, actorId),
      incrementViewCount: (workspaceId, id) => articleRepo.incrementViewCount(db, workspaceId, id),
      softDelete: async (workspaceId, id, actorId) => {
        await articleRepo.softDelete(db, workspaceId, id, actorId)
      },
      restore: async (workspaceId, id) => {
        await articleRepo.restore(db, workspaceId, id)
      },
    },
    categories: {
      list: (workspaceId) => categoryRepo.list(db, workspaceId),
      findById: (workspaceId, id) => categoryRepo.findById(db, workspaceId, id),
      findBySlug: (workspaceId, slug) => categoryRepo.findBySlug(db, workspaceId, slug),
      create: (workspaceId, input, actorId) =>
        categoryRepo.create(db, workspaceId, input as unknown as CreateKbCategoryInput, actorId),
      update: (workspaceId, id, input, actorId) =>
        categoryRepo.update(
          db,
          workspaceId,
          id,
          input as unknown as UpdateKbCategoryInput,
          actorId,
        ),
      softDelete: async (workspaceId, id, actorId) => {
        await categoryRepo.softDelete(db, workspaceId, id, actorId)
      },
    },
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "user" })
    },
    search: {
      indexArticle: (ctx, article) =>
        searchService.indexRecord(ctx, {
          objectType: "article",
          recordId: article.id,
          title: article.title,
          body: article.body,
          ownerId: article.authorId ?? undefined,
          visibility: "workspace",
        }),
      removeArticle: (ctx, articleId) =>
        searchService.removeRecord(ctx, { objectType: "article", recordId: articleId }),
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
  const code = err instanceof Error ? (err as { code?: string }).code : undefined
  if (code === "NOT_FOUND") {
    return c.json(errorEnvelope("NOT_FOUND", (err as Error).message, requestId), 404)
  }
  if (code === "CONFLICT") {
    return c.json(errorEnvelope("CONFLICT", (err as Error).message, requestId), 409)
  }
  // Slug content rules (allowlist regex, reserved words) are enforced in the
  // service, not by the boundary zod schema — see `slug.ts` — so a rejected
  // slug surfaces here as a domain VALIDATION_ERROR, not a zod issue.
  if (code === "VALIDATION_ERROR") {
    const details = (err as { details?: unknown }).details
    return c.json(
      errorEnvelope("VALIDATION_ERROR", (err as Error).message, requestId, details),
      400,
    )
  }
  throw err
}

function invalidBody(requestId: string | undefined, message: string, details: unknown) {
  return errorEnvelope("VALIDATION_ERROR", message, requestId, details)
}

export function createRoutes(deps: KnowledgeBaseRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  let cached: KnowledgeBaseService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  // --- Categories ---------------------------------------------------------

  app.get("/categories", requireSession(), async (c) => {
    try {
      const data = await service().listCategories(serviceContextOf(c))
      return c.json({ data })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/categories",
    requireSession(),
    zValidator("json", createKbCategorySchema, (result, c) => {
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
        const category = await service().createCategory(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: category }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/categories/:id", requireSession(), async (c) => {
    try {
      const category = await service().getCategory(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: category })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.patch(
    "/categories/:id",
    requireSession(),
    zValidator("json", updateKbCategorySchema, (result, c) => {
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
        const category = await service().updateCategory(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: category })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.delete("/categories/:id", requireSession(), async (c) => {
    try {
      await service().deleteCategory(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: { deleted: true } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  // --- Articles ------------------------------------------------------------

  app.get(
    "/articles",
    requireSession(),
    zValidator("query", kbArticleQuerySchema, (result, c) => {
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
        const result = await service().listArticles(serviceContextOf(c), c.req.valid("query"))
        return c.json(result)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post(
    "/articles",
    requireSession(),
    zValidator("json", createKbArticleSchema, (result, c) => {
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
        const article = await service().createArticle(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: article }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/articles/:id", requireSession(), async (c) => {
    try {
      const article = await service().getArticle(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: article })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.patch(
    "/articles/:id",
    requireSession(),
    zValidator("json", updateKbArticleSchema, (result, c) => {
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
        const article = await service().updateArticle(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: article })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.delete("/articles/:id", requireSession(), async (c) => {
    try {
      await service().softDeleteArticle(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: { deleted: true } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post("/articles/:id/restore", requireSession(), async (c) => {
    try {
      const article = await service().restoreArticle(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: article })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post("/articles/:id/publish", requireSession(), async (c) => {
    try {
      const article = await service().publishArticle(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: article })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post("/articles/:id/unpublish", requireSession(), async (c) => {
    try {
      const article = await service().unpublishArticle(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: article })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post("/articles/:id/archive", requireSession(), async (c) => {
    try {
      const article = await service().archiveArticle(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: article })
    } catch (err) {
      return mapError(c, err)
    }
  })

  return app
}

export const openApiPaths = {
  "/api/v1/knowledge-base/categories": {
    get: { summary: "List knowledge base categories", operationId: "listKbCategories" },
    post: {
      summary: "Create a category",
      operationId: "createKbCategory",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createKbCategorySchema) } },
      },
    },
  },
  "/api/v1/knowledge-base/categories/{id}": {
    get: { summary: "Get a category", operationId: "getKbCategory" },
    patch: {
      summary: "Update a category",
      operationId: "updateKbCategory",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateKbCategorySchema) } },
      },
    },
    delete: { summary: "Soft-delete a category", operationId: "deleteKbCategory" },
  },
  "/api/v1/knowledge-base/articles": {
    get: {
      summary: "List articles (cursor pagination, category filter)",
      operationId: "listKbArticles",
    },
    post: {
      summary: "Create an article (draft)",
      operationId: "createKbArticle",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createKbArticleSchema) } },
      },
    },
  },
  "/api/v1/knowledge-base/articles/{id}": {
    get: {
      summary: "Get an article (draft/archived requires edit permission)",
      operationId: "getKbArticle",
    },
    patch: {
      summary: "Update an article",
      operationId: "updateKbArticle",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateKbArticleSchema) } },
      },
    },
    delete: { summary: "Soft-delete an article", operationId: "deleteKbArticle" },
  },
  "/api/v1/knowledge-base/articles/{id}/restore": {
    post: { summary: "Restore a soft-deleted article", operationId: "restoreKbArticle" },
  },
  "/api/v1/knowledge-base/articles/{id}/publish": {
    post: {
      summary: "Publish an article and index it for search",
      operationId: "publishKbArticle",
    },
  },
  "/api/v1/knowledge-base/articles/{id}/unpublish": {
    post: {
      summary: "Unpublish an article and remove it from search",
      operationId: "unpublishKbArticle",
    },
  },
  "/api/v1/knowledge-base/articles/{id}/archive": {
    post: {
      summary: "Archive an article and remove it from search",
      operationId: "archiveKbArticle",
    },
  },
}

export { articleEnvelope, articleListEnvelope, categoryEnvelope, categoryListEnvelope }
