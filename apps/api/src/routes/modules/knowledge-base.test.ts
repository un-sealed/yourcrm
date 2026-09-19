import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import {
  createKnowledgeBaseService,
  type KnowledgeBaseService,
} from "@yourcrm/crm/src/knowledge-base"
import type {
  KbArticleListQuery,
  KbArticleRecord,
  KbArticleStatus,
  KbCategoryRecord,
  KbSearchIndexPort,
} from "@yourcrm/crm/src/knowledge-base"
import { createApiClient, createStore, makeBaseRecord, makeSession } from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes } from "./knowledge-base"

type StoredArticle = BaseRecord & {
  title: string
  slug: string
  body: string
  status: string
  categoryId: string | null
  authorId: string | null
  publishedAt: string | null
  viewCount: number
}

type StoredCategory = BaseRecord & { name: string; slug: string; description: string | null }

function asArticle(row: StoredArticle): KbArticleRecord {
  return row as unknown as KbArticleRecord
}

function asCategory(row: StoredCategory): KbCategoryRecord {
  return row as unknown as KbCategoryRecord
}

/** Real domain service over a hermetic in-memory store, wired the same way the API route does. */
function makeFakeService(): { service: KnowledgeBaseService; indexed: Map<string, unknown> } {
  const articles = createStore<StoredArticle>()
  const categories = createStore<StoredCategory>()
  const indexed = new Map<string, unknown>()

  const articleStore = {
    list: async (
      workspaceId: string,
      query: KbArticleListQuery & { includeUnpublished: boolean },
    ) => {
      let rows = articles.list(workspaceId)
      if (query.status) rows = rows.filter((r) => r.status === query.status)
      else if (!query.includeUnpublished) rows = rows.filter((r) => r.status === "published")
      const limit = query.limit ?? 25
      const data = rows.slice(0, limit)
      return {
        data: data.map(asArticle),
        pagination: {
          nextCursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null,
          limit,
        },
      }
    },
    findById: async (workspaceId: string, id: string) => {
      const row = articles.get(id, workspaceId)
      return row ? asArticle(row) : null
    },
    findBySlug: async (workspaceId: string, slug: string) => {
      const row = articles.list(workspaceId).find((r) => r.slug === slug)
      return row ? asArticle(row) : null
    },
    create: async (workspaceId: string, input: Record<string, unknown>, actorId?: string) => {
      const record: StoredArticle = {
        ...makeBaseRecord({ workspaceId }),
        title: input.title as string,
        slug: input.slug as string,
        body: (input.body as string | undefined) ?? "",
        status: (input.status as string | undefined) ?? "draft",
        categoryId: (input.categoryId as string | null | undefined) ?? null,
        authorId: actorId ?? null,
        publishedAt: null,
        viewCount: 0,
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      }
      return asArticle(articles.insert(record))
    },
    update: async (workspaceId: string, id: string, input: Record<string, unknown>) => {
      const row = articles.update(id, workspaceId, input as Partial<StoredArticle>)
      return row ? asArticle(row) : null
    },
    setStatus: async (workspaceId: string, id: string, status: KbArticleStatus) => {
      const current = articles.get(id, workspaceId)
      const publishedAt =
        status === "published"
          ? (current?.publishedAt ?? new Date().toISOString())
          : (current?.publishedAt ?? null)
      const row = articles.update(id, workspaceId, { status, publishedAt })
      return row ? asArticle(row) : null
    },
    incrementViewCount: async (workspaceId: string, id: string) => {
      const current = articles.get(id, workspaceId)
      if (current) articles.update(id, workspaceId, { viewCount: current.viewCount + 1 })
    },
    softDelete: async (workspaceId: string, id: string) => {
      articles.remove(id, workspaceId)
    },
    restore: async (workspaceId: string, id: string) => {
      articles.restore(id, workspaceId)
    },
  }

  const categoryStore = {
    list: async (workspaceId: string) => categories.list(workspaceId).map(asCategory),
    findById: async (workspaceId: string, id: string) => {
      const row = categories.get(id, workspaceId)
      return row ? asCategory(row) : null
    },
    findBySlug: async (workspaceId: string, slug: string) => {
      const row = categories.list(workspaceId).find((r) => r.slug === slug)
      return row ? asCategory(row) : null
    },
    create: async (workspaceId: string, input: Record<string, unknown>, actorId?: string) => {
      const record: StoredCategory = {
        ...makeBaseRecord({ workspaceId }),
        name: input.name as string,
        slug: input.slug as string,
        description: (input.description as string | null | undefined) ?? null,
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      }
      return asCategory(categories.insert(record))
    },
    update: async (workspaceId: string, id: string, input: Record<string, unknown>) => {
      const row = categories.update(id, workspaceId, input as Partial<StoredCategory>)
      return row ? asCategory(row) : null
    },
    softDelete: async (workspaceId: string, id: string) => {
      categories.remove(id, workspaceId)
    },
  }

  const search: KbSearchIndexPort = {
    indexArticle: async (_ctx, article) => {
      indexed.set(article.id, article)
    },
    removeArticle: async (_ctx, articleId) => {
      indexed.delete(articleId)
    },
  }

  const service = createKnowledgeBaseService({
    articles: articleStore,
    categories: categoryStore,
    audit: async () => undefined,
    search,
  })
  return { service, indexed }
}

function makeTestApp(session: { current: Session | null }, service: KnowledgeBaseService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/knowledge-base", createRoutes({ service }))
  return app
}

describe("api/knowledge-base", () => {
  let session: { current: Session | null }
  let fake: { service: KnowledgeBaseService; indexed: Map<string, unknown> }

  beforeEach(() => {
    const owner = makeSession({ role: "owner" })
    session = { current: owner }
    fake = makeFakeService()
  })

  test("unauthenticated requests get UNAUTHORIZED", async () => {
    session.current = null
    const api = createApiClient({ app: makeTestApp(session, fake.service) })
    const res = await api.get("/api/v1/knowledge-base/articles")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("create validates the body and returns 201", async () => {
    const api = createApiClient({ app: makeTestApp(session, fake.service) })
    const bad = await api.post("/api/v1/knowledge-base/articles", { title: "" })
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")
    const good = await api.post("/api/v1/knowledge-base/articles", {
      title: "Getting started",
      slug: "getting-started",
      body: "Hello",
    })
    expect(good.status).toBe(201)
    const data = good.expectSuccess().data as { status: string; slug: string }
    expect(data.status).toBe("draft")
    expect(data.slug).toBe("getting-started")
  })

  test("create rejects a slug outside the allowlist", async () => {
    const api = createApiClient({ app: makeTestApp(session, fake.service) })
    const res = await api.post("/api/v1/knowledge-base/articles", {
      title: "Bad",
      slug: "Not Valid!",
    })
    expect(res.status).toBe(400)
  })

  test("create rejects a duplicate slug with CONFLICT", async () => {
    const api = createApiClient({ app: makeTestApp(session, fake.service) })
    await api.post("/api/v1/knowledge-base/articles", { title: "One", slug: "dup" })
    const res = await api.post("/api/v1/knowledge-base/articles", { title: "Two", slug: "dup" })
    expect(res.status).toBe(409)
    res.expectError("CONFLICT")
  })

  test("viewer create is FORBIDDEN (service denial maps to 403)", async () => {
    session.current = makeSession({ role: "viewer" })
    const api = createApiClient({ app: makeTestApp(session, fake.service) })
    const res = await api.post("/api/v1/knowledge-base/articles", { title: "Nope", slug: "nope" })
    expect(res.status).toBe(403)
    res.expectError("FORBIDDEN")
  })

  test("draft visibility: a viewer gets NOT_FOUND on an unpublished article, an editor sees it", async () => {
    const owner = makeSession({ role: "owner" })
    session.current = owner
    const api = createApiClient({ app: makeTestApp(session, fake.service) })
    const created = await api.post("/api/v1/knowledge-base/articles", {
      title: "Draft",
      slug: "draft-article",
    })
    const articleId = (created.expectSuccess().data as { id: string }).id

    const ownerRead = await api.get(`/api/v1/knowledge-base/articles/${articleId}`)
    expect(ownerRead.status).toBe(200)

    session.current = makeSession({ role: "viewer", workspaceId: owner.workspaceId })
    const viewerApi = createApiClient({ app: makeTestApp(session, fake.service) })
    const viewerRead = await viewerApi.get(`/api/v1/knowledge-base/articles/${articleId}`)
    expect(viewerRead.status).toBe(404)
    viewerRead.expectError("NOT_FOUND")
  })

  test("publish makes the article visible to viewers and indexes it for search", async () => {
    // Two independent session wrappers/apps: `makeTestApp`'s middleware reads
    // `session.current` at request time, so reusing one mutable wrapper for
    // both roles would make every later "owner" call see the last role set.
    const owner = makeSession({ role: "owner" })
    const ownerSession = { current: owner as Session | null }
    const api = createApiClient({ app: makeTestApp(ownerSession, fake.service) })
    const created = await api.post("/api/v1/knowledge-base/articles", {
      title: "Public",
      slug: "public-article",
    })
    const articleId = (created.expectSuccess().data as { id: string }).id

    const published = await api.post(`/api/v1/knowledge-base/articles/${articleId}/publish`)
    expect(published.status).toBe(200)
    expect(fake.indexed.has(articleId)).toBe(true)

    const viewerSession = {
      current: makeSession({ role: "viewer", workspaceId: owner.workspaceId }) as Session | null,
    }
    const viewerApi = createApiClient({ app: makeTestApp(viewerSession, fake.service) })
    const viewerRead = await viewerApi.get(`/api/v1/knowledge-base/articles/${articleId}`)
    expect(viewerRead.status).toBe(200)

    const unpublished = await api.post(`/api/v1/knowledge-base/articles/${articleId}/unpublish`)
    expect(unpublished.status).toBe(200)
    expect(fake.indexed.has(articleId)).toBe(false)
  })

  test("categories: create, list and delete round-trip", async () => {
    const api = createApiClient({ app: makeTestApp(session, fake.service) })
    const created = await api.post("/api/v1/knowledge-base/categories", {
      name: "Guides",
      slug: "guides",
    })
    expect(created.status).toBe(201)
    const category = created.expectSuccess().data as { id: string }
    const listed = await api.get("/api/v1/knowledge-base/categories")
    expect((listed.expectSuccess().data as unknown[]).length).toBe(1)
    const deleted = await api.delete(`/api/v1/knowledge-base/categories/${category.id}`)
    expect(deleted.status).toBe(200)
  })

  test("update, delete and restore round-trip", async () => {
    const api = createApiClient({ app: makeTestApp(session, fake.service) })
    const created = await api.post("/api/v1/knowledge-base/articles", {
      title: "Round trip",
      slug: "round-trip",
    })
    const articleId = (created.expectSuccess().data as { id: string }).id
    const patched = await api.patch(`/api/v1/knowledge-base/articles/${articleId}`, {
      title: "Renamed",
    })
    expect(patched.status).toBe(200)
    const deleted = await api.delete(`/api/v1/knowledge-base/articles/${articleId}`)
    expect(deleted.status).toBe(200)
    const restored = await api.post(`/api/v1/knowledge-base/articles/${articleId}/restore`)
    expect(restored.status).toBe(200)
  })
})
