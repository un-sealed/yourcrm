import { and, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import {
  isKbArticleStatus,
  kbArticles,
  kbCategories,
  type KbArticle,
  type KbCategory,
  type NewKbArticle,
  type NewKbCategory,
} from "../schema/knowledge-base"
import { createBaseRepository } from "./base-repository"

/**
 * Knowledge Base repositories (spec 22-knowledge-base, P0).
 *
 * Slug *content* validation (allowlist regex, reserved words) lives in
 * `packages/crm/src/knowledge-base/slug.ts` and runs in the domain service —
 * the same rule for HTTP, MCP and AI callers (mirrors
 * `custom-objects-repository.ts`). This layer only normalizes case/whitespace
 * and enforces the length the column allows, plus the real per-workspace
 * uniqueness guard: the partial unique index in 0260_knowledge_base.sql.
 */

export type CreateKbCategoryInput = {
  name: string
  slug: string
  description?: string | null
}

export type UpdateKbCategoryInput = Partial<CreateKbCategoryInput>

export type CreateKbArticleInput = {
  title: string
  slug: string
  body?: string | null
  categoryId?: string | null
  authorId?: string | null
  status?: string | null
}

export type UpdateKbArticleInput = Partial<
  Pick<CreateKbArticleInput, "title" | "slug" | "body" | "categoryId">
>

function normalizeName(value: string, field: string, max = 255): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new Error(`knowledge-base: ${field} must not be empty`)
  if (trimmed.length > max)
    throw new Error(`knowledge-base: ${field} must be at most ${max} characters`)
  return trimmed
}

function toCategoryValues(
  input: CreateKbCategoryInput | UpdateKbCategoryInput,
  actorId?: string,
): Partial<NewKbCategory> {
  const values: Partial<NewKbCategory> = {}
  if (input.name !== undefined) values.name = normalizeName(input.name, "name")
  if (input.slug !== undefined) values.slug = input.slug
  if (input.description !== undefined) values.description = input.description?.trim() || null
  if (actorId !== undefined) values.updatedBy = actorId
  return values
}

function toArticleValues(
  input: CreateKbArticleInput | UpdateKbArticleInput,
  actorId?: string,
): Partial<NewKbArticle> {
  const values: Partial<NewKbArticle> = {}
  if (input.title !== undefined) values.title = normalizeName(input.title, "title")
  if (input.slug !== undefined) values.slug = input.slug
  if (input.body !== undefined) values.body = input.body ?? ""
  if (input.categoryId !== undefined) values.categoryId = input.categoryId
  if ("status" in input && input.status !== undefined) {
    if (input.status !== null && !isKbArticleStatus(input.status)) {
      throw new Error("knowledge-base: status must be one of draft, published, archived")
    }
    values.status = input.status ?? "draft"
  }
  if ("authorId" in input && input.authorId !== undefined) values.authorId = input.authorId
  if (actorId !== undefined) values.updatedBy = actorId
  return values
}

export function createKbCategoryRepository() {
  const base = createBaseRepository(kbCategories)

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateKbCategoryInput,
      actorId?: string,
    ): Promise<KbCategory> {
      const rows = await db
        .insert(kbCategories)
        .values({
          ...toCategoryValues(input, actorId),
          workspaceId,
          name: normalizeName(input.name, "name"),
          slug: input.slug,
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("knowledge-base.categories.create: insert returned no rows")
      return row
    },

    async list(db: Database, workspaceId: string): Promise<KbCategory[]> {
      const result = await base.list(db, { workspaceId, limit: 200, order: "asc" })
      return result.data as KbCategory[]
    },

    async findById(db: Database, workspaceId: string, id: string): Promise<KbCategory | null> {
      // The shared base narrows rows to the BaseRecord columns; re-select the
      // concrete table here so callers get the full KbCategory shape.
      const row = await base.findById(db, workspaceId, id)
      return (row as KbCategory | null) ?? null
    },

    async findBySlug(db: Database, workspaceId: string, slug: string): Promise<KbCategory | null> {
      const rows = await db
        .select()
        .from(kbCategories)
        .where(
          and(
            eq(kbCategories.workspaceId, workspaceId),
            eq(kbCategories.slug, slug),
            isNull(kbCategories.deletedAt),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateKbCategoryInput,
      actorId?: string,
    ): Promise<KbCategory | null> {
      const rows = await db
        .update(kbCategories)
        .set({ ...toCategoryValues(input, actorId), updatedAt: new Date() })
        .where(
          and(
            eq(kbCategories.id, id),
            eq(kbCategories.workspaceId, workspaceId),
            isNull(kbCategories.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },
  }
}

export type KbCategoryRepository = ReturnType<typeof createKbCategoryRepository>

export function createKbArticleRepository() {
  const base = createBaseRepository(kbArticles)

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateKbArticleInput,
      actorId?: string,
    ): Promise<KbArticle> {
      const status = input.status ?? "draft"
      if (!isKbArticleStatus(status)) {
        throw new Error("knowledge-base: status must be one of draft, published, archived")
      }
      const rows = await db
        .insert(kbArticles)
        .values({
          workspaceId,
          title: normalizeName(input.title, "title"),
          slug: input.slug,
          body: input.body ?? "",
          categoryId: input.categoryId ?? null,
          authorId: input.authorId ?? actorId ?? null,
          status,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("knowledge-base.articles.create: insert returned no rows")
      return row
    },

    /** Cursor-paginated list with optional case-insensitive title search and filters. */
    async search(
      db: Database,
      opts: {
        workspaceId: string
        limit?: number
        cursor?: string
        order?: "asc" | "desc"
        query?: string
        status?: string
        categoryId?: string
        /** When false, only `published` rows are returned (reader visibility). */
        includeUnpublished?: boolean
      },
    ) {
      const conditions: SQL[] = []
      if (opts.query) {
        const q = `%${opts.query.trim()}%`
        const match = or(ilike(kbArticles.title, q), ilike(kbArticles.body, q))
        if (match) conditions.push(match)
      }
      if (opts.categoryId) conditions.push(eq(kbArticles.categoryId, opts.categoryId))
      if (opts.status) {
        if (!isKbArticleStatus(opts.status))
          throw new Error("knowledge-base: unknown status filter")
        conditions.push(eq(kbArticles.status, opts.status))
      } else if (opts.includeUnpublished !== true) {
        conditions.push(eq(kbArticles.status, "published"))
      }
      const result = await base.list(db, { ...opts, where: conditions })
      return { data: result.data as KbArticle[], pagination: result.pagination }
    },

    async findBySlug(db: Database, workspaceId: string, slug: string): Promise<KbArticle | null> {
      const rows = await db
        .select()
        .from(kbArticles)
        .where(
          and(
            eq(kbArticles.workspaceId, workspaceId),
            eq(kbArticles.slug, slug),
            isNull(kbArticles.deletedAt),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateKbArticleInput,
      actorId?: string,
    ): Promise<KbArticle | null> {
      const rows = await db
        .update(kbArticles)
        .set({ ...toArticleValues(input, actorId), updatedAt: new Date() })
        .where(
          and(
            eq(kbArticles.id, id),
            eq(kbArticles.workspaceId, workspaceId),
            isNull(kbArticles.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    /** Transition status (publish/unpublish/archive). Sets `publishedAt` on first publish. */
    async setStatus(
      db: Database,
      workspaceId: string,
      id: string,
      status: string,
      actorId?: string,
    ): Promise<KbArticle | null> {
      if (!isKbArticleStatus(status)) {
        throw new Error("knowledge-base: status must be one of draft, published, archived")
      }
      const current = await this.findById(db, workspaceId, id)
      const publishedAt =
        status === "published" ? (current?.publishedAt ?? new Date()) : current?.publishedAt
      const rows = await db
        .update(kbArticles)
        .set({
          status,
          publishedAt: publishedAt ?? null,
          updatedAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(
          and(
            eq(kbArticles.id, id),
            eq(kbArticles.workspaceId, workspaceId),
            isNull(kbArticles.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    /** Best-effort read counter: bumps `view_count`, never touches `updated_at`/`updated_by`. */
    async incrementViewCount(db: Database, workspaceId: string, id: string): Promise<void> {
      await db
        .update(kbArticles)
        .set({ viewCount: sql`${kbArticles.viewCount} + 1` })
        .where(
          and(
            eq(kbArticles.id, id),
            eq(kbArticles.workspaceId, workspaceId),
            isNull(kbArticles.deletedAt),
          ),
        )
    },

    async findById(db: Database, workspaceId: string, id: string): Promise<KbArticle | null> {
      const row = await base.findById(db, workspaceId, id)
      return (row as KbArticle | null) ?? null
    },
  }
}

export type KbArticleRepository = ReturnType<typeof createKbArticleRepository>
