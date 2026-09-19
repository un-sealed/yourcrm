import { checkPermission, requirePermission } from "@yourcrm/permissions"
import { KbArticleNotFoundError, KbCategoryNotFoundError, KbConflictError } from "./errors"
import {
  createKbArticleSchema,
  createKbCategorySchema,
  kbArticleQuerySchema,
  updateKbArticleSchema,
  updateKbCategorySchema,
} from "./schemas"
import { parseKbSlug } from "./slug"
import type {
  KbArticleListResult,
  KbArticleRecord,
  KbCategoryRecord,
  KnowledgeBaseServiceContext,
  KnowledgeBaseServiceDeps,
} from "./types"

function articlePermissionOf(
  ctx: KnowledgeBaseServiceContext,
  action: "read" | "create" | "update" | "delete",
) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "kb_article",
    action,
  }
}

function categoryPermissionOf(
  ctx: KnowledgeBaseServiceContext,
  action: "read" | "create" | "update" | "delete",
) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "kb_category",
    action,
  }
}

/** True when the caller holds edit rights on articles (draft visibility gate). */
function canEditArticles(ctx: KnowledgeBaseServiceContext): boolean {
  return checkPermission(articlePermissionOf(ctx, "update")).allowed
}

/**
 * Knowledge Base domain service (spec 22-knowledge-base, P0), following the
 * People reference shape.
 *
 * DRAFT VISIBILITY (spec 22 §6/§15): an unpublished (`draft` or `archived`)
 * article must not be readable by anyone without edit permission. A hidden
 * article is reported as NOT_FOUND rather than FORBIDDEN — the same "does
 * not exist" answer for readers without edit rights as for a genuinely
 * missing id, so drafts cannot be probed by id (mirrors
 * `search/policy.ts#canReadSearchDocument`). `list` applies the same rule:
 * a non-editor's query is pinned to `status: "published"` regardless of what
 * it asks for.
 *
 * SEARCH (spec 22 §11, instructions §5): published articles are pushed into
 * the shared `search_index` through the injected `search` port
 * (`KbSearchIndexPort`, adapted to the real search domain service by the API
 * route) on publish, and pulled back out on unpublish/archive/delete —
 * nothing here talks to `search_index` directly or grows a second
 * full-text implementation.
 *
 * EVENTS: spec 22 §9 names `article.created`, `article.updated`,
 * `article.published`, but `@yourcrm/events` exports no Knowledge Base event
 * group and event names may never be string literals (hard rule). No domain
 * events are emitted — this is a BLOCKER, reported alongside this module —
 * audit rows cover every mutation in the meantime (same posture as
 * `search/service.ts`'s NOTE on `search.executed`).
 */
export function createKnowledgeBaseService(deps: KnowledgeBaseServiceDeps) {
  async function safeIndex(ctx: KnowledgeBaseServiceContext, article: KbArticleRecord) {
    if (!deps.search) return
    await deps.search.indexArticle(ctx, {
      id: article.id,
      title: article.title as string,
      body: article.body as string,
      authorId: article.authorId ?? null,
    })
  }

  async function safeUnindex(ctx: KnowledgeBaseServiceContext, articleId: string) {
    if (!deps.search) return
    try {
      await deps.search.removeArticle(ctx, articleId)
    } catch {
      // Not indexed (never published, or already removed) — nothing to undo.
    }
  }

  // ---------------------------------------------------------------------
  // Categories
  // ---------------------------------------------------------------------

  async function listCategories(ctx: KnowledgeBaseServiceContext): Promise<KbCategoryRecord[]> {
    requirePermission(categoryPermissionOf(ctx, "read"))
    return deps.categories.list(ctx.workspaceId)
  }

  async function getCategory(
    ctx: KnowledgeBaseServiceContext,
    id: string,
  ): Promise<KbCategoryRecord> {
    requirePermission(categoryPermissionOf(ctx, "read"))
    const found = await deps.categories.findById(ctx.workspaceId, id)
    if (!found) throw new KbCategoryNotFoundError(id)
    return found
  }

  async function createCategory(
    ctx: KnowledgeBaseServiceContext,
    rawInput: unknown,
  ): Promise<KbCategoryRecord> {
    requirePermission(categoryPermissionOf(ctx, "create"))
    const input = createKbCategorySchema.parse(rawInput)
    const slug = parseKbSlug(input.slug)
    const clash = await deps.categories.findBySlug(ctx.workspaceId, slug)
    if (clash) throw new KbConflictError(`a category with slug "${slug}" already exists`)
    const category = await deps.categories.create(ctx.workspaceId, { ...input, slug }, ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "kb_category",
      recordId: category.id,
      after: category,
      correlationId: ctx.correlationId,
    })
    return category
  }

  async function updateCategory(
    ctx: KnowledgeBaseServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<KbCategoryRecord> {
    requirePermission(categoryPermissionOf(ctx, "update"))
    const patch = updateKbCategorySchema.parse(rawPatch)
    const before = await deps.categories.findById(ctx.workspaceId, id)
    if (!before) throw new KbCategoryNotFoundError(id)
    const after = await deps.categories.update(
      ctx.workspaceId,
      id,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new KbCategoryNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "kb_category",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function deleteCategory(ctx: KnowledgeBaseServiceContext, id: string): Promise<void> {
    requirePermission(categoryPermissionOf(ctx, "delete"))
    const before = await deps.categories.findById(ctx.workspaceId, id)
    if (!before) throw new KbCategoryNotFoundError(id)
    await deps.categories.softDelete(ctx.workspaceId, id, ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "kb_category",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
  }

  // ---------------------------------------------------------------------
  // Articles
  // ---------------------------------------------------------------------

  async function listArticles(
    ctx: KnowledgeBaseServiceContext,
    rawQuery: unknown,
  ): Promise<KbArticleListResult> {
    requirePermission(articlePermissionOf(ctx, "read"))
    const query = kbArticleQuerySchema.parse(rawQuery)
    const canEdit = canEditArticles(ctx)
    // Draft visibility (spec 22 §6): a reader without edit rights only ever
    // sees published articles, no matter what status it asked for.
    const status = canEdit ? query.status : "published"
    return deps.articles.list(ctx.workspaceId, { ...query, status, includeUnpublished: canEdit })
  }

  async function getArticle(
    ctx: KnowledgeBaseServiceContext,
    id: string,
  ): Promise<KbArticleRecord> {
    requirePermission(articlePermissionOf(ctx, "read"))
    const found = await deps.articles.findById(ctx.workspaceId, id)
    if (!found || (found.status !== "published" && !canEditArticles(ctx))) {
      throw new KbArticleNotFoundError(id)
    }
    if (found.status !== "published") return found
    // Best-effort read counter: never fails the read. `found` was fetched
    // before the bump, so reflect it in the value handed back to the caller
    // rather than re-querying.
    await deps.articles.incrementViewCount(ctx.workspaceId, id).catch(() => undefined)
    const priorViewCount = typeof found.viewCount === "number" ? found.viewCount : 0
    return { ...found, viewCount: priorViewCount + 1 }
  }

  async function createArticle(
    ctx: KnowledgeBaseServiceContext,
    rawInput: unknown,
  ): Promise<KbArticleRecord> {
    requirePermission(articlePermissionOf(ctx, "create"))
    const input = createKbArticleSchema.parse(rawInput)
    const slug = parseKbSlug(input.slug)
    const clash = await deps.articles.findBySlug(ctx.workspaceId, slug)
    if (clash) throw new KbConflictError(`an article with slug "${slug}" already exists`)
    if (input.categoryId) {
      const category = await deps.categories.findById(ctx.workspaceId, input.categoryId)
      if (!category) throw new KbCategoryNotFoundError(input.categoryId)
    }
    const article = await deps.articles.create(
      ctx.workspaceId,
      { ...input, slug, status: "draft" },
      ctx.actorId,
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "kb_article",
      recordId: article.id,
      after: article,
      correlationId: ctx.correlationId,
    })
    return article
  }

  async function updateArticle(
    ctx: KnowledgeBaseServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<KbArticleRecord> {
    requirePermission(articlePermissionOf(ctx, "update"))
    const patch = updateKbArticleSchema.parse(rawPatch)
    const before = await deps.articles.findById(ctx.workspaceId, id)
    if (!before) throw new KbArticleNotFoundError(id)
    const values: Record<string, unknown> = { ...patch }
    if (patch.slug !== undefined) {
      const slug = parseKbSlug(patch.slug)
      const clash = await deps.articles.findBySlug(ctx.workspaceId, slug)
      if (clash && clash.id !== id) {
        throw new KbConflictError(`an article with slug "${slug}" already exists`)
      }
      values.slug = slug
    }
    if (patch.categoryId) {
      const category = await deps.categories.findById(ctx.workspaceId, patch.categoryId)
      if (!category) throw new KbCategoryNotFoundError(patch.categoryId)
    }
    const after = await deps.articles.update(ctx.workspaceId, id, values, ctx.actorId)
    if (!after) throw new KbArticleNotFoundError(id)
    // Keep an already-published article's indexed copy in step with edits.
    if (after.status === "published") await safeIndex(ctx, after)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "kb_article",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function publishArticle(
    ctx: KnowledgeBaseServiceContext,
    id: string,
  ): Promise<KbArticleRecord> {
    requirePermission(articlePermissionOf(ctx, "update"))
    const before = await deps.articles.findById(ctx.workspaceId, id)
    if (!before) throw new KbArticleNotFoundError(id)
    const after = await deps.articles.setStatus(ctx.workspaceId, id, "published", ctx.actorId)
    if (!after) throw new KbArticleNotFoundError(id)
    await safeIndex(ctx, after)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "publish",
      object: "kb_article",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function unpublishArticle(
    ctx: KnowledgeBaseServiceContext,
    id: string,
  ): Promise<KbArticleRecord> {
    requirePermission(articlePermissionOf(ctx, "update"))
    const before = await deps.articles.findById(ctx.workspaceId, id)
    if (!before) throw new KbArticleNotFoundError(id)
    const after = await deps.articles.setStatus(ctx.workspaceId, id, "draft", ctx.actorId)
    if (!after) throw new KbArticleNotFoundError(id)
    await safeUnindex(ctx, id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "unpublish",
      object: "kb_article",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function archiveArticle(
    ctx: KnowledgeBaseServiceContext,
    id: string,
  ): Promise<KbArticleRecord> {
    requirePermission(articlePermissionOf(ctx, "update"))
    const before = await deps.articles.findById(ctx.workspaceId, id)
    if (!before) throw new KbArticleNotFoundError(id)
    const after = await deps.articles.setStatus(ctx.workspaceId, id, "archived", ctx.actorId)
    if (!after) throw new KbArticleNotFoundError(id)
    await safeUnindex(ctx, id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "archive",
      object: "kb_article",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function softDeleteArticle(
    ctx: KnowledgeBaseServiceContext,
    id: string,
  ): Promise<KbArticleRecord> {
    requirePermission(articlePermissionOf(ctx, "delete"))
    const before = await deps.articles.findById(ctx.workspaceId, id)
    if (!before) throw new KbArticleNotFoundError(id)
    await deps.articles.softDelete(ctx.workspaceId, id, ctx.actorId)
    await safeUnindex(ctx, id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "kb_article",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function restoreArticle(
    ctx: KnowledgeBaseServiceContext,
    id: string,
  ): Promise<KbArticleRecord> {
    requirePermission(articlePermissionOf(ctx, "update"))
    await deps.articles.restore(ctx.workspaceId, id)
    const after = await deps.articles.findById(ctx.workspaceId, id)
    if (!after) throw new KbArticleNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "restore",
      object: "kb_article",
      recordId: id,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  return {
    listCategories,
    getCategory,
    createCategory,
    updateCategory,
    deleteCategory,
    listArticles,
    getArticle,
    createArticle,
    updateArticle,
    publishArticle,
    unpublishArticle,
    archiveArticle,
    softDeleteArticle,
    restoreArticle,
  }
}

export type KnowledgeBaseService = ReturnType<typeof createKnowledgeBaseService>
