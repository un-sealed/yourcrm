import { searchQuerySchema, type SearchHit, type SearchProvider, type SearchResult } from "./search"

/**
 * PostgreSQL full-text implementation of {@link SearchProvider} (spec
 * 28-search, P0). Replaces {@link NoopSearchProvider} for callers that reach
 * search through this abstraction rather than through the domain service —
 * AI tools, MCP and the worker.
 *
 * It is a thin adapter on purpose. All ranking and SQL live in
 * `@yourcrm/database`'s `search-repository.ts`; all permission filtering
 * lives in `@yourcrm/crm`'s search service. This package depends on neither
 * (it ships with `zod` only), so both arrive through the structural
 * {@link PermissionAwareSearchStore} port — which is satisfied as-is by
 * `createSearchService(...)`.
 *
 * ## Why `resolveActor` is mandatory
 *
 * `SearchQuery` carries a workspace but no actor, and spec 28 §8 requires
 * every result to be filtered by the caller's permissions. A provider bound
 * to the real index must therefore be told who is asking; returning `null`
 * fails the query closed with {@link SearchActorRequiredError} instead of
 * silently answering with workspace-wide data.
 */

/** The principal whose permissions results are filtered by. */
export type SearchActor = {
  actorId: string
  /** Workspace role, resolved by `@yourcrm/auth`. */
  role?: string
}

type SearchCallContext = {
  workspaceId: string
  actorId: string
  role?: string
}

type StoreHit = Record<string, unknown> & {
  objectType: string
  recordId: string
  title: string
  rank: number
}

/**
 * Structural mirror of the `@yourcrm/crm` search service. Any object with
 * these methods satisfies it, including the hermetic test fake.
 */
export type PermissionAwareSearchStore = {
  search(
    ctx: SearchCallContext,
    query: { query: string; object?: string; limit?: number; cursor?: string },
  ): Promise<{ data: StoreHit[]; pagination: { nextCursor: string | null; limit: number } }>
  indexRecord(
    ctx: SearchCallContext,
    document: {
      objectType: string
      recordId: string
      title: string
      body?: string | null
    },
  ): Promise<unknown>
}

export type PostgresSearchProviderDeps = {
  store: PermissionAwareSearchStore
  /** Resolves the acting principal for a workspace. `null` fails closed. */
  resolveActor: (workspaceId: string) => SearchActor | null | Promise<SearchActor | null>
}

/** Thrown when no principal can be resolved: search must never run unfiltered. */
export class SearchActorRequiredError extends Error {
  readonly code = "FORBIDDEN"
  constructor(workspaceId: string) {
    super(`search: no actor resolved for workspace ${workspaceId}; refusing to search unfiltered`)
    this.name = "SearchActorRequiredError"
  }
}

function toHit(row: StoreHit): SearchHit {
  const snippet = row.snippet
  return {
    object: row.objectType,
    recordId: row.recordId,
    title: row.title,
    rank: row.rank,
    ...(typeof snippet === "string" ? { snippet } : {}),
  }
}

export function createPostgresSearchProvider(deps: PostgresSearchProviderDeps): SearchProvider {
  async function contextFor(workspaceId: string): Promise<SearchCallContext> {
    const actor = await deps.resolveActor(workspaceId)
    if (!actor) throw new SearchActorRequiredError(workspaceId)
    return {
      workspaceId,
      actorId: actor.actorId,
      ...(actor.role === undefined ? {} : { role: actor.role }),
    }
  }

  return {
    name: "postgres-fts",

    async search(rawQuery): Promise<SearchResult> {
      const query = searchQuerySchema.parse(rawQuery)
      const ctx = await contextFor(query.workspaceId)
      const objects = query.objects ?? []

      // 0 or 1 object type is the common path: one ranked index scan. Several
      // types means one scan each, merged by rank — the domain service takes a
      // single optional filter so the HTTP query string stays flat.
      if (objects.length <= 1) {
        const object = objects[0]
        const page = await deps.store.search(ctx, {
          query: query.query,
          limit: query.limit,
          ...(object === undefined ? {} : { object }),
        })
        return { query: query.query, hits: page.data.map(toHit) }
      }

      const pages = await Promise.all(
        objects.map((object) =>
          deps.store.search(ctx, { query: query.query, limit: query.limit, object }),
        ),
      )
      const hits = pages
        .flatMap((page) => page.data.map(toHit))
        .sort((a, b) => b.rank - a.rank)
        .slice(0, query.limit)
      return { query: query.query, hits }
    },

    async indexDocument(doc): Promise<void> {
      const ctx = await contextFor(doc.workspaceId)
      await deps.store.indexRecord(ctx, {
        objectType: doc.object,
        recordId: doc.recordId,
        // The abstraction carries one blob of text; the index stores the first
        // line as the title so a hit is readable without loading the record.
        title: firstLine(doc.text),
        body: doc.text,
      })
    },
  }
}

/** First non-empty line of the indexed text, trimmed to a displayable title. */
export function firstLine(text: string, maxLength = 512): string {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0)
  const title = (line ?? text).replace(/\s+/g, " ").trim()
  if (title.length === 0) throw new Error("search.indexDocument: text must not be empty")
  return title.length > maxLength ? title.slice(0, maxLength) : title
}
