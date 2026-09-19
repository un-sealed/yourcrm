import type { ServiceContext } from "../index"
import type { AuditWriter } from "../ports"

/**
 * Global search service ports (spec 28-search, P0).
 *
 * `@yourcrm/crm` has no database dependency, so the service never imports
 * `@yourcrm/database`. It depends on these structural ports instead; the API
 * layer adapts the drizzle repository (`search-repository.ts`) and
 * `writeAudit` to them, and hermetic tests satisfy them with a fake.
 *
 * `AuditWriter` / `EventEmitter` come from `../ports` — never redeclared here
 * (see that file for why).
 */

/**
 * Object types the index accepts. Mirrors `SEARCH_OBJECT_TYPES` in
 * `@yourcrm/database`'s `schema/search.ts`; the two lists are kept in step by
 * hand because the domain layer may not import the database package (the same
 * arrangement as `PEOPLE_STATUSES`).
 */
export const SEARCH_OBJECT_TYPES = [
  "person",
  "company",
  "lead",
  "deal",
  "activity",
  "task",
  "file",
  "form",
  "product",
  "invoice",
  // Added by the Knowledge Base agent (spec 22) — kept in step by hand with
  // `packages/database/src/schema/search.ts` and
  // `apps/web/app/app/search/types.ts`.
  "article",
] as const

export type SearchObjectType = (typeof SEARCH_OBJECT_TYPES)[number]

/**
 * Record-level visibility captured at index time.
 * `workspace` — anyone who may read the object type.
 * `private` — the owner only, plus actors with workspace admin rights.
 */
export const SEARCH_VISIBILITIES = ["workspace", "private"] as const

export type SearchVisibility = (typeof SEARCH_VISIBILITIES)[number]

/** Pass-through index row: inputs are zod-validated, outputs flow to envelopes. */
export type SearchDocumentRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  objectType: string
  recordId: string
  title: string
  ownerId?: string | null
  visibility?: string
}

/** One ranked result. The store replaces the indexed body with a snippet. */
export type SearchHitRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  objectType: string
  recordId: string
  title: string
  rank: number
}

export type SearchHitListResult = {
  data: SearchHitRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

/**
 * Query the store receives. `objects` is already permission-filtered by the
 * service, and `includePrivate` carries the caller's record-visibility scope,
 * so the store can push both filters into SQL ahead of pagination.
 */
export type SearchStoreQuery = {
  query: string
  objects: string[]
  limit?: number
  cursor?: string
  actorId?: string
  includePrivate?: boolean
}

export type SearchStore = {
  query(workspaceId: string, query: SearchStoreQuery): Promise<SearchHitListResult>
  upsert(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<SearchDocumentRecord>
  /** Soft-delete the index row for one record. Resolves with rows affected. */
  removeByRecord(
    workspaceId: string,
    objectType: string,
    recordId: string,
    actorId?: string,
  ): Promise<number>
  findByRecord(
    workspaceId: string,
    objectType: string,
    recordId: string,
  ): Promise<SearchDocumentRecord | null>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type SearchAuditInput = {
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

export type SearchServiceContext = ServiceContext

export type SearchServiceDeps = {
  store: SearchStore
  audit: AuditWriter<SearchAuditInput>
}
