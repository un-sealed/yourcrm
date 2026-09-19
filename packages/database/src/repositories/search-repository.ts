import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import { isSearchObjectType, isSearchVisibility, searchIndex } from "../schema/search"
import { createBaseRepository } from "./base-repository"

/**
 * Search index repository (spec 28-search, P0).
 *
 * The only place search SQL lives. Two responsibilities:
 *
 * 1. **Indexing** — `upsert` / `removeByRecord`, keyed on
 *    (workspace, object type, record id) so a module can re-index a record
 *    any number of times without duplicating it.
 * 2. **Querying** — one GIN-backed full-text scan, ranked with `ts_rank`.
 *
 * Permission filtering happens *here*, inside the WHERE clause: the domain
 * service passes the object types the caller may read plus the caller's
 * record-visibility scope, so denied rows never reach pagination (filtering
 * after the fact would return short or empty pages).
 */

/** Longest indexed title/subtitle. Mirrors what the UI can display. */
export const SEARCH_TITLE_MAX_LENGTH = 512

/** Bodies are truncated, not rejected: indexing must never fail on a long note. */
export const SEARCH_BODY_MAX_LENGTH = 20_000

/** Default snippet length returned with each hit. */
export const SEARCH_SNIPPET_LENGTH = 160

const documentColumns = {
  id: searchIndex.id,
  workspaceId: searchIndex.workspaceId,
  createdAt: searchIndex.createdAt,
  updatedAt: searchIndex.updatedAt,
  createdBy: searchIndex.createdBy,
  updatedBy: searchIndex.updatedBy,
  deletedAt: searchIndex.deletedAt,
  ownerId: searchIndex.ownerId,
  objectType: searchIndex.objectType,
  recordId: searchIndex.recordId,
  title: searchIndex.title,
  subtitle: searchIndex.subtitle,
  body: searchIndex.body,
  visibility: searchIndex.visibility,
  recordUpdatedAt: searchIndex.recordUpdatedAt,
}

/** An index row as the application sees it (the tsvector stays in Postgres). */
export type SearchDocument = Omit<typeof searchIndex.$inferSelect, "searchVector">

/** One ranked result. `body` is replaced by a query-centred `snippet`. */
export type SearchHitRow = Omit<SearchDocument, "body"> & {
  rank: number
  snippet: string | null
}

export type UpsertSearchDocumentInput = {
  objectType: string
  recordId: string
  title: string
  subtitle?: string | null
  body?: string | null
  ownerId?: string | null
  visibility?: string | null
  recordUpdatedAt?: Date | string | null
}

export type SearchQueryOptions = {
  workspaceId: string
  /** Raw user text. Tokenized into a prefix tsquery — never interpolated. */
  query: string
  /** Object types the caller is allowed to read. Empty means "no results". */
  objects: string[]
  limit?: number
  cursor?: string | null
  /** Caller id: `private` rows they own stay visible to them. */
  actorId?: string | null
  /** True for workspace admins: `private` rows stay visible regardless of owner. */
  includePrivate?: boolean
}

/** Trimmed, non-empty title (max {@link SEARCH_TITLE_MAX_LENGTH}). */
export function normalizeSearchTitle(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new Error("search.index: title must not be empty")
  if (trimmed.length > SEARCH_TITLE_MAX_LENGTH) {
    throw new Error(`search.index: title must be at most ${SEARCH_TITLE_MAX_LENGTH} characters`)
  }
  return trimmed
}

/** Indexed bodies are collapsed and truncated rather than rejected. */
export function truncateSearchBody(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim()
  return collapsed.length > SEARCH_BODY_MAX_LENGTH
    ? collapsed.slice(0, SEARCH_BODY_MAX_LENGTH)
    : collapsed
}

/** Split user text into lexeme-safe terms (letters and digits only). */
export function searchTerms(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0)
}

/**
 * Build a prefix `to_tsquery` expression from free text, e.g.
 * `"ada lov"` -> `"ada:* & lov:*"`. Returns null when the text carries no
 * searchable term, which the caller turns into an empty page instead of a
 * Postgres syntax error. Terms are stripped to letters/digits *and* bound as
 * a parameter, so no user text ever reaches the query as SQL.
 *
 * Every term is required (`&`) and prefix-matched (`:*`) — the behaviour a
 * command palette wants, where each word typed narrows the list. The `simple`
 * text-search configuration keeps stop words as lexemes, so a query like
 * `"the ada"` really does require both.
 */
export function toTsQuery(raw: string): string | null {
  const terms = searchTerms(raw)
  if (terms.length === 0) return null
  return terms.map((term) => `${term}:*`).join(" & ")
}

/**
 * Plain-text snippet centred on the first matching term. Computed in
 * TypeScript rather than with `ts_headline` so results carry no markup and
 * the query stays a single cheap index scan.
 */
export function buildSnippet(
  body: string | null | undefined,
  query: string,
  maxLength = SEARCH_SNIPPET_LENGTH,
): string | null {
  if (body === null || body === undefined) return null
  const text = body.replace(/\s+/g, " ").trim()
  if (text.length === 0) return null
  if (text.length <= maxLength) return text
  const term = searchTerms(query)[0]
  const at = term === undefined ? -1 : text.toLowerCase().indexOf(term)
  if (at < 0) return `${text.slice(0, maxLength).trimEnd()}…`
  const start = Math.max(0, at - Math.floor(maxLength / 3))
  const end = Math.min(text.length, start + maxLength)
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`
}

/**
 * Cursor codec. Rank is computed per query, so a keyset cursor on
 * `(rank, id)` would need the client to round-trip a float; the cursor stays
 * an opaque token holding the rank-ordered offset instead. Clients must treat
 * it as opaque so this can become a keyset cursor without an API change.
 */
export function encodeSearchCursor(offset: number): string {
  return String(offset)
}

export function decodeSearchCursor(cursor?: string | null): number {
  if (cursor === null || cursor === undefined || cursor === "") return 0
  if (!/^\d{1,9}$/.test(cursor)) throw new Error("search.query: cursor is not a valid cursor token")
  return Number(cursor)
}

function toRecordUpdatedAt(value: Date | string | null | undefined): Date | undefined {
  if (value === null || value === undefined) return undefined
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error("search.index: recordUpdatedAt is not a date")
  return date
}

/** Column values shared by insert and the conflict update. */
function toSearchValues(input: UpsertSearchDocumentInput, actorId?: string) {
  if (!isSearchObjectType(input.objectType)) {
    throw new Error(`search.index: objectType must be one of ${searchObjectTypeList()}`)
  }
  if (input.recordId.trim().length === 0) {
    throw new Error("search.index: recordId must not be empty")
  }
  if (input.visibility !== undefined && input.visibility !== null) {
    if (!isSearchVisibility(input.visibility)) {
      throw new Error("search.index: visibility must be one of workspace, private")
    }
  }
  const subtitle = input.subtitle?.trim() || null
  if (subtitle !== null && subtitle.length > SEARCH_TITLE_MAX_LENGTH) {
    throw new Error(`search.index: subtitle must be at most ${SEARCH_TITLE_MAX_LENGTH} characters`)
  }
  const recordUpdatedAt = toRecordUpdatedAt(input.recordUpdatedAt)
  return {
    objectType: input.objectType,
    recordId: input.recordId.trim(),
    title: normalizeSearchTitle(input.title),
    subtitle,
    body: input.body === null || input.body === undefined ? null : truncateSearchBody(input.body),
    ownerId: input.ownerId ?? null,
    visibility: input.visibility ?? "workspace",
    ...(recordUpdatedAt === undefined ? {} : { recordUpdatedAt }),
    ...(actorId === undefined ? {} : { updatedBy: actorId }),
  }
}

function searchObjectTypeList(): string {
  return "person, company, lead, deal, activity, task, file, form, product, invoice"
}

export function createSearchRepository() {
  const base = createBaseRepository(searchIndex)

  return {
    ...base,

    /**
     * Index (or re-index) one record. Idempotent on
     * (workspace, object type, record id); re-indexing a removed record
     * clears its `deleted_at`.
     */
    async upsert(
      db: Database,
      workspaceId: string,
      input: UpsertSearchDocumentInput,
      actorId?: string,
    ): Promise<SearchDocument> {
      const values = toSearchValues(input, actorId)
      const rows = await db
        .insert(searchIndex)
        .values({
          ...values,
          workspaceId,
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .onConflictDoUpdate({
          target: [searchIndex.workspaceId, searchIndex.objectType, searchIndex.recordId],
          set: { ...values, updatedAt: new Date(), deletedAt: null },
        })
        .returning(documentColumns)
      const row = rows[0]
      if (!row) throw new Error("search.index: upsert returned no rows")
      return row
    },

    /** Soft-delete the index row for one record. Returns rows affected (0 or 1). */
    async removeByRecord(
      db: Database,
      workspaceId: string,
      objectType: string,
      recordId: string,
      actorId?: string,
    ): Promise<number> {
      if (!isSearchObjectType(objectType)) {
        throw new Error(`search.index: objectType must be one of ${searchObjectTypeList()}`)
      }
      const rows = await db
        .update(searchIndex)
        .set({
          deletedAt: new Date(),
          updatedAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(
          and(
            eq(searchIndex.workspaceId, workspaceId),
            eq(searchIndex.objectType, objectType),
            eq(searchIndex.recordId, recordId),
            isNull(searchIndex.deletedAt),
          ),
        )
        .returning({ id: searchIndex.id })
      return rows.length
    },

    async findByRecord(
      db: Database,
      workspaceId: string,
      objectType: string,
      recordId: string,
    ): Promise<SearchDocument | null> {
      const rows = await db
        .select(documentColumns)
        .from(searchIndex)
        .where(
          and(
            eq(searchIndex.workspaceId, workspaceId),
            eq(searchIndex.objectType, objectType),
            eq(searchIndex.recordId, recordId),
            isNull(searchIndex.deletedAt),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },

    /**
     * Ranked full-text query. `opts.objects` is the permission-filtered list
     * of object types from the domain service — an empty list short-circuits
     * to an empty page, and unknown types are rejected rather than ignored.
     */
    async query(
      db: Database,
      opts: SearchQueryOptions,
    ): Promise<{ data: SearchHitRow[]; pagination: { nextCursor: string | null; limit: number } }> {
      const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100)
      const offset = decodeSearchCursor(opts.cursor)
      const empty = { data: [] as SearchHitRow[], pagination: { nextCursor: null, limit } }

      for (const object of opts.objects) {
        if (!isSearchObjectType(object)) {
          throw new Error(`search.query: objectType must be one of ${searchObjectTypeList()}`)
        }
      }
      if (opts.objects.length === 0) return empty
      const tsQuery = toTsQuery(opts.query)
      if (tsQuery === null) return empty

      const match = sql`to_tsquery('simple', ${tsQuery})`
      const rank = sql<number>`ts_rank(${searchIndex.searchVector}, ${match})`

      const conditions: SQL[] = [
        eq(searchIndex.workspaceId, opts.workspaceId),
        isNull(searchIndex.deletedAt),
        inArray(searchIndex.objectType, opts.objects),
        sql`${searchIndex.searchVector} @@ ${match}`,
      ]
      // Record-level permission filter: `private` rows belong to their owner
      // (plus workspace admins, who arrive with includePrivate).
      if (opts.includePrivate !== true) {
        const visible = opts.actorId
          ? or(
              eq(searchIndex.visibility, "workspace"),
              and(eq(searchIndex.visibility, "private"), eq(searchIndex.ownerId, opts.actorId)),
            )
          : eq(searchIndex.visibility, "workspace")
        if (visible) conditions.push(visible)
      }

      const rows = await db
        .select({ ...documentColumns, rank })
        .from(searchIndex)
        .where(and(...conditions))
        .orderBy(desc(rank), desc(searchIndex.recordUpdatedAt), asc(searchIndex.id))
        .limit(limit + 1)
        .offset(offset)

      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      return {
        data: page.map(({ body, ...rest }) => ({
          ...rest,
          snippet: buildSnippet(body, opts.query),
        })),
        pagination: { nextCursor: hasMore ? encodeSearchCursor(offset + limit) : null, limit },
      }
    },
  }
}

export type SearchRepository = ReturnType<typeof createSearchRepository>
