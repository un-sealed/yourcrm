import { checkPermission } from "@yourcrm/permissions"
import { SEARCH_OBJECT_TYPES, type SearchDocumentRecord, type SearchObjectType } from "./types"
import type { SearchServiceContext } from "./types"

/**
 * Result-level permission policy (spec 28-search §8: "all results filtered by
 * normal permissions").
 *
 * Workspace scoping alone is not enough: a hit is a pointer into another
 * module's record, so the caller must be allowed to read *that* object type,
 * and must be allowed to see *that* record. Both facts are resolved here and
 * pushed down into the SQL WHERE clause — filtering after the fact would hand
 * back short pages and leak row counts.
 *
 * These build on `@yourcrm/permissions`; they never replace it. Every service
 * method still calls `requirePermission()` first.
 */

/**
 * Object types this caller may read, in index order. Empty means "return no
 * results" — the service short-circuits instead of querying.
 */
export function readableSearchObjects(ctx: SearchServiceContext): SearchObjectType[] {
  return SEARCH_OBJECT_TYPES.filter(
    (object) =>
      checkPermission({
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        role: ctx.role ?? "viewer",
        object,
        action: "read",
      }).allowed,
  )
}

/**
 * True when the caller may see `private` rows they do not own — i.e. holds
 * workspace admin rights. Everyone else sees `workspace` rows plus their own.
 */
export function canReadAllRecords(ctx: SearchServiceContext): boolean {
  return checkPermission({
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "search",
    action: "admin",
  }).allowed
}

/**
 * Record-level visibility check for a single document. The store applies the
 * same rule in SQL; this mirrors it for single-record lookups so a private
 * document cannot be probed by id.
 */
export function canReadSearchDocument(
  ctx: SearchServiceContext,
  document: Pick<SearchDocumentRecord, "objectType" | "ownerId" | "visibility">,
): boolean {
  if (!readableSearchObjects(ctx).some((object) => object === document.objectType)) return false
  if (document.visibility !== "private") return true
  if (document.ownerId !== null && document.ownerId === ctx.actorId) return true
  return canReadAllRecords(ctx)
}
