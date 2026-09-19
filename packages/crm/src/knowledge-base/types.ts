import type { ServiceContext } from "../index"
import type { AuditWriter } from "../ports"

/**
 * Knowledge Base service ports (spec 22-knowledge-base, P0), mirroring the
 * People reference shape.
 *
 * `@yourcrm/crm` has no database dependency, so the service never imports
 * `@yourcrm/database`. It depends on these structural ports instead; the API
 * layer adapts the drizzle repositories
 * (`knowledge-base-repository.ts`) and `writeAudit` to them. Any object with
 * matching methods satisfies the port — including the fakes in hermetic
 * tests.
 *
 * `AuditWriter` / `EventEmitter` come from `../ports` — never redeclared here
 * (see that file for why).
 */

export const KB_ARTICLE_STATUSES = ["draft", "published", "archived"] as const

export type KbArticleStatus = (typeof KB_ARTICLE_STATUSES)[number]

export function isKbArticleStatus(value: unknown): value is KbArticleStatus {
  return typeof value === "string" && (KB_ARTICLE_STATUSES as readonly string[]).includes(value)
}

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type KbArticleRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  status: string
  slug: string
  authorId?: string | null
}

export type KbCategoryRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  slug: string
}

export type KbArticleListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
  status?: string
  categoryId?: string
}

export type KbArticleListResult = {
  data: KbArticleRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type KbArticleStore = {
  /** `includeUnpublished` is set by the service once it knows the caller may edit. */
  list(
    workspaceId: string,
    query: KbArticleListQuery & { includeUnpublished: boolean },
  ): Promise<KbArticleListResult>
  findById(workspaceId: string, id: string): Promise<KbArticleRecord | null>
  findBySlug(workspaceId: string, slug: string): Promise<KbArticleRecord | null>
  create(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<KbArticleRecord>
  update(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<KbArticleRecord | null>
  setStatus(
    workspaceId: string,
    id: string,
    status: KbArticleStatus,
    actorId?: string,
  ): Promise<KbArticleRecord | null>
  incrementViewCount(workspaceId: string, id: string): Promise<void>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  restore(workspaceId: string, id: string): Promise<void>
}

export type KbCategoryStore = {
  list(workspaceId: string): Promise<KbCategoryRecord[]>
  findById(workspaceId: string, id: string): Promise<KbCategoryRecord | null>
  findBySlug(workspaceId: string, slug: string): Promise<KbCategoryRecord | null>
  create(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<KbCategoryRecord>
  update(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<KbCategoryRecord | null>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
}

/**
 * Narrow port onto the global search domain service
 * (`packages/crm/src/search`). The KB service pushes published articles into
 * the shared `search_index` through this rather than growing a second search
 * implementation, and pulls them back out on unpublish/archive/delete.
 * Optional: when absent (e.g. a unit test that only cares about article
 * CRUD), publish/unpublish still work — they just skip indexing.
 */
export type KbSearchArticlePayload = {
  id: string
  title: string
  body: string
  authorId?: string | null
}

export type KbSearchIndexPort = {
  indexArticle(ctx: ServiceContext, article: KbSearchArticlePayload): Promise<unknown>
  removeArticle(ctx: ServiceContext, articleId: string): Promise<unknown>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type KbAuditInput = {
  workspaceId: string
  actorId?: string | null
  action: string
  object: string
  recordId?: string | null
  before?: unknown
  after?: unknown
  correlationId?: string | null
  source?: "user" | "automation" | "ai" | "integration" | "mcp"
}

export type KnowledgeBaseServiceContext = ServiceContext

export type KnowledgeBaseServiceDeps = {
  articles: KbArticleStore
  categories: KbCategoryStore
  audit: AuditWriter<KbAuditInput>
  search?: KbSearchIndexPort
}
