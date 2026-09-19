import { requirePermission } from "@yourcrm/permissions"
import { canReadAllRecords, canReadSearchDocument, readableSearchObjects } from "./policy"
import { searchDocumentRefSchema, searchIndexDocumentSchema, searchQuerySchema } from "./schemas"
import type {
  SearchDocumentRecord,
  SearchHitListResult,
  SearchServiceContext,
  SearchServiceDeps,
} from "./types"

export class SearchDocumentNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(objectType: string, recordId: string) {
    super(`${objectType} ${recordId} is not indexed`)
    this.name = "SearchDocumentNotFoundError"
  }
}

export type SearchRemovalResult = {
  objectType: string
  recordId: string
  /** Index rows soft-deleted (0 or 1). */
  removed: number
}

function permissionOf(ctx: SearchServiceContext, action: "read" | "update" | "delete") {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "search",
    action,
  }
}

/**
 * Global search domain service (spec 28-search, P0).
 *
 * Two halves behind one service, both following the People reference shape:
 *
 * - **Indexing** (`indexRecord` / `removeRecord`) — modules push a
 *   denormalized document per record. Idempotent, audited, no events (see the
 *   note below).
 * - **Querying** (`search` / `getIndexed`) — Postgres full-text through the
 *   injected store.
 *
 * Every method calls `requirePermission()` FIRST. On top of that module-level
 * gate, reads are filtered by the caller's *result* permissions: the object
 * types they may read (`readableSearchObjects`) and the records they may see
 * (`canReadAllRecords` / `canReadSearchDocument`), both pushed into the store
 * query so denied rows never reach pagination. See `policy.ts`.
 *
 * NOTE (events): spec 28 §9 names `search.executed` and `command.executed`,
 * but `@yourcrm/events` exports no constant for either and event names may
 * never be string literals. No domain events are emitted until those
 * constants land; audit rows cover the index mutations in the meantime.
 */
export function createSearchService(deps: SearchServiceDeps) {
  async function search(
    ctx: SearchServiceContext,
    rawQuery: unknown,
  ): Promise<SearchHitListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = searchQuerySchema.parse(rawQuery)
    const readable = readableSearchObjects(ctx)
    const objects =
      query.object === undefined
        ? (readable as string[])
        : readable.filter((object) => object === query.object)
    if (objects.length === 0) {
      return { data: [], pagination: { nextCursor: null, limit: query.limit } }
    }
    return deps.store.query(ctx.workspaceId, {
      query: query.query,
      objects,
      limit: query.limit,
      cursor: query.cursor,
      actorId: ctx.actorId,
      includePrivate: canReadAllRecords(ctx),
    })
  }

  /** The indexed document for one record, or NOT_FOUND when hidden/absent. */
  async function getIndexed(
    ctx: SearchServiceContext,
    rawRef: unknown,
  ): Promise<SearchDocumentRecord> {
    requirePermission(permissionOf(ctx, "read"))
    const ref = searchDocumentRefSchema.parse(rawRef)
    const found = await deps.store.findByRecord(ctx.workspaceId, ref.objectType, ref.recordId)
    // A hidden document is reported as missing so its existence cannot be
    // probed by id — the same answer the filtered query gives.
    if (!found || !canReadSearchDocument(ctx, found)) {
      throw new SearchDocumentNotFoundError(ref.objectType, ref.recordId)
    }
    return found
  }

  /**
   * Index or re-index one record. Idempotent on (object type, record id):
   * calling it again updates the existing row and revives a removed one.
   */
  async function indexRecord(
    ctx: SearchServiceContext,
    rawInput: unknown,
  ): Promise<SearchDocumentRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const input = searchIndexDocumentSchema.parse(rawInput)
    const before = await deps.store.findByRecord(ctx.workspaceId, input.objectType, input.recordId)
    const after = await deps.store.upsert(
      ctx.workspaceId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: before ? "update" : "create",
      object: "search_index",
      recordId: after.id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /** Drop one record from the index (called by modules on delete/archive). */
  async function removeRecord(
    ctx: SearchServiceContext,
    rawRef: unknown,
  ): Promise<SearchRemovalResult> {
    requirePermission(permissionOf(ctx, "delete"))
    const ref = searchDocumentRefSchema.parse(rawRef)
    const before = await deps.store.findByRecord(ctx.workspaceId, ref.objectType, ref.recordId)
    if (!before) throw new SearchDocumentNotFoundError(ref.objectType, ref.recordId)
    const removed = await deps.store.removeByRecord(
      ctx.workspaceId,
      ref.objectType,
      ref.recordId,
      ctx.actorId,
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "search_index",
      recordId: before.id,
      before,
      correlationId: ctx.correlationId,
    })
    return { objectType: ref.objectType, recordId: ref.recordId, removed }
  }

  return { search, getIndexed, indexRecord, removeRecord }
}

export type SearchService = ReturnType<typeof createSearchService>
