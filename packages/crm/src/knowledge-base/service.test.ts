import { beforeEach, describe, expect, test } from "bun:test"
import {
  createStore,
  expectAllowed,
  expectDenied,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import type { ServiceContext } from "../index"
import { createKnowledgeBaseService, type KnowledgeBaseService } from "./index"
import type {
  KbArticleListQuery,
  KbArticleRecord,
  KbArticleStatus,
  KbAuditInput,
  KbCategoryRecord,
  KbSearchIndexPort,
} from "./types"

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

function makeStores() {
  const articles = createStore<StoredArticle>()
  const categories = createStore<StoredCategory>()

  const articleStore = {
    list: async (
      workspaceId: string,
      query: KbArticleListQuery & { includeUnpublished: boolean },
    ) => {
      let rows = articles.list(workspaceId)
      if (query.status) rows = rows.filter((r) => r.status === query.status)
      else if (!query.includeUnpublished) rows = rows.filter((r) => r.status === "published")
      if (query.categoryId) rows = rows.filter((r) => r.categoryId === query.categoryId)
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

  return { articles, categories, articleStore, categoryStore }
}

function makeSearchFake() {
  const indexed = new Map<string, { title: string; body: string }>()
  const calls: string[] = []
  const search: KbSearchIndexPort = {
    indexArticle: async (_ctx, article) => {
      calls.push(`index:${article.id}`)
      indexed.set(article.id, { title: article.title, body: article.body })
    },
    removeArticle: async (_ctx, articleId) => {
      if (!indexed.has(articleId))
        throw Object.assign(new Error("not indexed"), { code: "NOT_FOUND" })
      calls.push(`remove:${articleId}`)
      indexed.delete(articleId)
    },
  }
  return { search, indexed, calls }
}

function setup(
  role: "owner" | "admin" | "member" | "viewer" = "owner",
  shared?: ReturnType<typeof makeStores>,
  workspaceId?: string,
) {
  const session = makeSession({ role, ...(workspaceId === undefined ? {} : { workspaceId }) })
  const ctx = makeServiceContext({ session })
  const audits: KbAuditInput[] = []
  const backing = shared ?? makeStores()
  const searchFake = makeSearchFake()
  const service = createKnowledgeBaseService({
    articles: backing.articleStore,
    categories: backing.categoryStore,
    audit: async (input) => void audits.push(input),
    search: searchFake.search,
  })
  return { ctx, service, audits, session, backing, searchFake }
}

async function seedCategory(service: KnowledgeBaseService, ctx: ServiceContext, slug = "guides") {
  return service.createCategory(ctx, { name: "Guides", slug })
}

async function seedArticle(
  service: KnowledgeBaseService,
  ctx: ServiceContext,
  slug = "getting-started",
) {
  return service.createArticle(ctx, { title: "Getting started", slug, body: "Hello world" })
}

describe("knowledge-base/service categories", () => {
  test("create validates the slug and audits", async () => {
    const { ctx, service, audits } = setup()
    const category = await expectAllowed(() => seedCategory(service, ctx))
    expect(category.slug).toBe("guides")
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ action: "create", object: "kb_category" })
  })

  test("create rejects a slug outside the allowlist", async () => {
    const { ctx, service } = setup()
    await expect(service.createCategory(ctx, { name: "Bad", slug: "Not Valid!" })).rejects.toThrow()
  })

  test("create rejects a duplicate slug in the same workspace", async () => {
    const { ctx, service } = setup()
    await seedCategory(service, ctx)
    await expect(seedCategory(service, ctx)).rejects.toMatchObject({ code: "CONFLICT" })
  })

  test("viewer cannot create a category", async () => {
    const { ctx, service } = setup("viewer")
    await expectDenied(() => seedCategory(service, ctx))
  })
})

describe("knowledge-base/service articles: draft visibility", () => {
  let backing: ReturnType<typeof makeStores>
  let owner: ReturnType<typeof setup>
  let articleId: string

  beforeEach(async () => {
    backing = makeStores()
    owner = setup("owner", backing)
    const article = await seedArticle(owner.service, owner.ctx)
    articleId = article.id
  })

  test("a fresh article is a draft and invisible to a viewer (NOT_FOUND, not FORBIDDEN)", async () => {
    const { ctx, service } = setup("viewer", backing, owner.ctx.workspaceId)
    const err = await service.getArticle(ctx, articleId).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe("NOT_FOUND")
  })

  test("a member has edit rights (role rank >= update) and can see the draft", async () => {
    const { ctx, service } = setup("member", backing, owner.ctx.workspaceId)
    const found = await expectAllowed(() => service.getArticle(ctx, articleId))
    expect(found.status).toBe("draft")
  })

  test("the creator (owner role) can read their own draft", async () => {
    const found = await expectAllowed(() => owner.service.getArticle(owner.ctx, articleId))
    expect(found.status).toBe("draft")
  })

  test("draft articles are excluded from a viewer's list, even when they ask for status=draft", async () => {
    const { ctx, service } = setup("viewer", backing, owner.ctx.workspaceId)
    const listed = await expectAllowed(() => service.listArticles(ctx, { status: "draft" }))
    expect(listed.data).toHaveLength(0)
  })

  test("once published, anyone with read access can see the article and the view count", async () => {
    await owner.service.publishArticle(owner.ctx, articleId)
    const { ctx, service } = setup("viewer", backing, owner.ctx.workspaceId)
    const found = await expectAllowed(() => service.getArticle(ctx, articleId))
    expect(found.status).toBe("published")
    expect(found.viewCount).toBe(1)
    const listed = await expectAllowed(() => service.listArticles(ctx, {}))
    expect(listed.data).toHaveLength(1)
  })

  test("viewer cannot publish, update or delete", async () => {
    const { ctx, service } = setup("viewer", backing, owner.ctx.workspaceId)
    await expectDenied(() => service.publishArticle(ctx, articleId))
    await expectDenied(() => service.updateArticle(ctx, articleId, { title: "New" }))
    await expectDenied(() => service.softDeleteArticle(ctx, articleId))
  })
})

describe("knowledge-base/service articles: search indexing", () => {
  test("publish indexes the article; unpublish and archive remove it", async () => {
    const { ctx, service, searchFake } = setup()
    const article = await seedArticle(service, ctx)

    await service.publishArticle(ctx, article.id)
    expect(searchFake.indexed.has(article.id)).toBe(true)

    await service.unpublishArticle(ctx, article.id)
    expect(searchFake.indexed.has(article.id)).toBe(false)

    await service.publishArticle(ctx, article.id)
    await service.archiveArticle(ctx, article.id)
    expect(searchFake.indexed.has(article.id)).toBe(false)
  })

  test("editing a published article re-indexes it; editing a draft does not", async () => {
    const { ctx, service, searchFake } = setup()
    const article = await seedArticle(service, ctx)
    await service.updateArticle(ctx, article.id, { title: "Still a draft" })
    expect(searchFake.calls).toEqual([])

    await service.publishArticle(ctx, article.id)
    await service.updateArticle(ctx, article.id, { title: "Updated title" })
    expect(searchFake.indexed.get(article.id)?.title).toBe("Updated title")
  })

  test("deleting a published article removes it from the index", async () => {
    const { ctx, service, searchFake } = setup()
    const article = await seedArticle(service, ctx)
    await service.publishArticle(ctx, article.id)
    await service.softDeleteArticle(ctx, article.id)
    expect(searchFake.indexed.has(article.id)).toBe(false)
  })

  test("indexing works fine when no search port is injected", async () => {
    const backing = makeStores()
    const ctx = makeServiceContext({ session: makeSession({ role: "owner" }) })
    const service = createKnowledgeBaseService({
      articles: backing.articleStore,
      categories: backing.categoryStore,
      audit: async () => undefined,
    })
    const article = await seedArticle(service, ctx)
    await expectAllowed(() => service.publishArticle(ctx, article.id))
  })
})

describe("knowledge-base/service articles: slugs and categories", () => {
  test("create rejects a duplicate slug in the same workspace", async () => {
    const { ctx, service } = setup()
    await seedArticle(service, ctx)
    await expect(seedArticle(service, ctx)).rejects.toMatchObject({ code: "CONFLICT" })
  })

  test("create rejects an unknown category id", async () => {
    const { ctx, service } = setup()
    await expect(
      service.createArticle(ctx, { title: "Ada", slug: "ada", categoryId: "missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  test("create accepts a real category id", async () => {
    const { ctx, service } = setup()
    const category = await seedCategory(service, ctx)
    const article = await expectAllowed(() =>
      service.createArticle(ctx, { title: "Ada", slug: "ada", categoryId: category.id }),
    )
    expect(article.categoryId).toBe(category.id)
  })

  test("update rejects renaming to a slug already used by another article", async () => {
    const { ctx, service } = setup()
    await seedArticle(service, ctx, "one")
    const second = await seedArticle(service, ctx, "two")
    await expect(service.updateArticle(ctx, second.id, { slug: "one" })).rejects.toMatchObject({
      code: "CONFLICT",
    })
  })

  test("update allows keeping the same slug", async () => {
    const { ctx, service } = setup()
    const article = await seedArticle(service, ctx, "one")
    const updated = await expectAllowed(() =>
      service.updateArticle(ctx, article.id, { slug: "one", title: "Renamed" }),
    )
    expect(updated.title).toBe("Renamed")
  })
})

describe("knowledge-base/service articles: soft delete and restore", () => {
  test("delete then restore round-trips a draft article", async () => {
    const { ctx, service } = setup()
    const article = await seedArticle(service, ctx)
    await expectAllowed(() => service.softDeleteArticle(ctx, article.id))
    await expect(service.getArticle(ctx, article.id)).rejects.toMatchObject({ code: "NOT_FOUND" })
    const restored = await expectAllowed(() => service.restoreArticle(ctx, article.id))
    expect(restored.id).toBe(article.id)
  })
})
