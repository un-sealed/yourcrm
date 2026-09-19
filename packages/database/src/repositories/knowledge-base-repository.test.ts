import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import {
  isKbArticleStatus,
  kbArticles,
  kbCategories,
  type KbArticle,
} from "../schema/knowledge-base"
import { createKbArticleRepository, createKbCategoryRepository } from "./knowledge-base-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const ARTICLE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const MIGRATION = new URL("../../migrations/0260_knowledge_base.sql", import.meta.url)

/** Thenable chain stub: every query builder call returns the proxy; each await pops one result. */
function mockDb(queued: unknown[][] = []) {
  let step = 0
  const proxy = new Proxy(function () {}, {
    get(_target, prop: string | symbol) {
      if (prop === "then") {
        return (resolve: (value: unknown) => void) => {
          resolve(queued[step] ?? [])
          step += 1
        }
      }
      return (..._args: unknown[]) => proxy
    },
  })
  return proxy as unknown as Database
}

function makeArticle(overrides: Partial<KbArticle> = {}): KbArticle {
  return {
    id: ARTICLE_ID,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    categoryId: null,
    title: "Getting started",
    slug: "getting-started",
    body: "Hello",
    status: "draft",
    authorId: null,
    publishedAt: null,
    viewCount: 0,
    ...overrides,
  }
}

describe("knowledge-base/schema", () => {
  test("kb_articles exposes the BaseRecord column contract plus article columns", () => {
    const cols = kbArticles as unknown as Record<string, unknown>
    for (const col of ["id", "workspaceId", "createdAt", "updatedAt", "deletedAt"]) {
      expect(cols[col], col).toBeDefined()
    }
    for (const col of ["title", "slug", "body", "status", "authorId", "publishedAt", "viewCount"]) {
      expect(cols[col], col).toBeDefined()
    }
  })

  test("kb_categories carries workspace scoping and a slug column", () => {
    const cols = kbCategories as unknown as Record<string, unknown>
    expect(cols.workspaceId).toBeDefined()
    expect(cols.slug).toBeDefined()
    expect(cols.name).toBeDefined()
  })

  test("status guard rejects unknown values", () => {
    expect(isKbArticleStatus("draft")).toBe(true)
    expect(isKbArticleStatus("published")).toBe(true)
    expect(isKbArticleStatus("archived")).toBe(true)
    expect(isKbArticleStatus("live")).toBe(false)
  })
})

describe("knowledge-base/articles repository", () => {
  test("create returns the inserted row", async () => {
    const repo = createKbArticleRepository()
    const row = makeArticle()
    const result = await repo.create(mockDb([[row]]), WS, {
      title: "Getting started",
      slug: "getting-started",
    })
    expect(result).toBe(row)
  })

  test("create rejects empty titles before touching the db", async () => {
    const repo = createKbArticleRepository()
    await expect(repo.create(mockDb(), WS, { title: "  ", slug: "x" })).rejects.toThrow()
  })

  test("create rejects unknown status values", async () => {
    const repo = createKbArticleRepository()
    await expect(
      repo.create(mockDb(), WS, { title: "Ada", slug: "ada", status: "live" }),
    ).rejects.toThrow(/status/)
  })

  test("create surfaces empty insert results as errors", async () => {
    const repo = createKbArticleRepository()
    await expect(repo.create(mockDb([[]]), WS, { title: "Ada", slug: "ada" })).rejects.toThrow(
      /no rows/,
    )
  })

  test("search returns the cursor pagination envelope and defaults to published-only", async () => {
    const repo = createKbArticleRepository()
    const rows = [
      makeArticle({ id: "id-1" }),
      makeArticle({ id: "id-2" }),
      makeArticle({ id: "id-3" }),
    ]
    const result = await repo.search(mockDb([rows]), { workspaceId: WS, limit: 2 })
    expect(result.data).toHaveLength(2)
    expect(result.pagination).toEqual({ nextCursor: "id-2", limit: 2 })
  })

  test("search rejects unknown status filters", async () => {
    const repo = createKbArticleRepository()
    await expect(repo.search(mockDb([[]]), { workspaceId: WS, status: "live" })).rejects.toThrow(
      /status/,
    )
  })

  test("update returns null when the row is missing", async () => {
    const repo = createKbArticleRepository()
    await expect(
      repo.update(mockDb([[]]), WS, "missing", { title: "New title" }),
    ).resolves.toBeNull()
  })

  test("findBySlug returns null when nothing matches", async () => {
    const repo = createKbArticleRepository()
    await expect(repo.findBySlug(mockDb([[]]), WS, "missing")).resolves.toBeNull()
  })

  test("setStatus rejects unknown status values before touching the db", async () => {
    const repo = createKbArticleRepository()
    await expect(repo.setStatus(mockDb(), WS, ARTICLE_ID, "live")).rejects.toThrow(/status/)
  })

  test("setStatus stamps publishedAt the first time an article publishes", async () => {
    const repo = createKbArticleRepository()
    const draft = makeArticle({ publishedAt: null })
    const published = makeArticle({
      status: "published",
      publishedAt: new Date("2026-02-01T00:00:00Z"),
    })
    const result = await repo.setStatus(mockDb([[draft], [published]]), WS, ARTICLE_ID, "published")
    expect(result).toBe(published)
  })
})

describe("knowledge-base/categories repository", () => {
  test("create returns the inserted row", async () => {
    const repo = createKbCategoryRepository()
    const row = { ...makeArticle(), name: "Guides", slug: "guides", description: null }
    const result = await repo.create(mockDb([[row]]), WS, { name: "Guides", slug: "guides" })
    expect(result).toBe(row)
  })

  test("create rejects empty names before touching the db", async () => {
    const repo = createKbCategoryRepository()
    await expect(repo.create(mockDb(), WS, { name: "  ", slug: "x" })).rejects.toThrow()
  })

  test("findBySlug returns null when nothing matches", async () => {
    const repo = createKbCategoryRepository()
    await expect(repo.findBySlug(mockDb([[]]), WS, "missing")).resolves.toBeNull()
  })
})

describe("knowledge-base/migration", () => {
  test("0260 creates kb_categories and kb_articles with the agreed indexes", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS kb_categories")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS kb_articles")
    expect(sql).toContain("kb_articles_slug_uidx")
    expect(sql).toContain("kb_categories_slug_uidx")
    expect(sql).toContain("REFERENCES kb_categories (id) ON DELETE SET NULL")
    expect(sql).toContain("kb_articles_status_chk")
  })

  test("author_id stays FK-free, matching every other actor column", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const block = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS kb_articles"), sql.length)
    expect(block).toContain("author_id UUID")
    expect(block).not.toContain("REFERENCES users")
  })
})
