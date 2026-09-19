import { sql } from "drizzle-orm"
import {
  customType,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { baseColumns, ownerColumn, workspaceColumn } from "./base"

/**
 * Global search index (spec 28-search, P0).
 *
 * One denormalized row per indexed record. Modules push their records here
 * through the indexing service (`@yourcrm/crm` search module); nothing reads
 * another module's tables to build results, which keeps the search query one
 * index scan instead of a dozen joins.
 *
 * - `record_id` is a PLAIN uuid column with an index and NO foreign key: the
 *   row it points at lives in whichever module table `object_type` names, and
 *   several of those tables are created by later migrations (same rule as
 *   `taggables.record_id` and `files.subject_id`).
 * - `search_vector` is a GENERATED STORED tsvector so every writer — the
 *   repository, a backfill job, psql — produces the same lexemes. Postgres
 *   full-text only: no pgvector, no embeddings, no external engine.
 * - `owner_id` + `visibility` carry the record-level permission facts the
 *   query needs, so denied rows are filtered in SQL rather than after
 *   pagination (see `search-repository.ts`).
 */

/** Object types the index accepts. Mirrored by `@yourcrm/crm` search schemas. */
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
  // Added by the Knowledge Base agent (spec 22): published kb_articles are
  // pushed here on publish and pulled back out on unpublish/archive/delete
  // (packages/crm/src/knowledge-base/service.ts). Kept in step by hand with
  // `packages/crm/src/search/types.ts` and `apps/web/app/app/search/types.ts`
  // — see the comment on that file's copy of this list.
  "article",
] as const

export type SearchObjectType = (typeof SEARCH_OBJECT_TYPES)[number]

export function isSearchObjectType(value: unknown): value is SearchObjectType {
  return typeof value === "string" && (SEARCH_OBJECT_TYPES as readonly string[]).includes(value)
}

/**
 * Record-level visibility captured at index time.
 * `workspace` — every member of the workspace who may read the object type.
 * `private` — only the owner, plus actors with workspace admin rights.
 */
export const SEARCH_VISIBILITIES = ["workspace", "private"] as const

export type SearchVisibility = (typeof SEARCH_VISIBILITIES)[number]

export function isSearchVisibility(value: unknown): value is SearchVisibility {
  return typeof value === "string" && (SEARCH_VISIBILITIES as readonly string[]).includes(value)
}

/**
 * Postgres `tsvector`. Read-only from application code: the column is
 * GENERATED ALWAYS, so drizzle never inserts or updates it.
 */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector"
  },
})

/**
 * Weighted lexeme expression, kept next to the table so the hand-written
 * migration and any future `drizzle-kit generate` agree. `simple` (not
 * `english`) on purpose: CRM titles are proper nouns, and prefix matching
 * (`ada:*`) gives better command-palette recall than English stemming.
 */
export const SEARCH_VECTOR_SQL = sql`setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(subtitle, '')), 'B') || setweight(to_tsvector('simple', coalesce(body, '')), 'C')`

export const searchIndex = pgTable(
  "search_index",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    objectType: varchar("object_type", { length: 64 }).notNull(),
    recordId: uuid("record_id").notNull(),
    title: text("title").notNull(),
    subtitle: text("subtitle"),
    body: text("body"),
    visibility: varchar("visibility", { length: 16 }).notNull().default("workspace"),
    recordUpdatedAt: timestamp("record_updated_at", { withTimezone: true }).notNull().defaultNow(),
    searchVector: tsvector("search_vector").generatedAlwaysAs(SEARCH_VECTOR_SQL),
  },
  (t) => [
    index("search_index_workspace_idx").on(t.workspaceId),
    index("search_index_object_idx").on(t.workspaceId, t.objectType),
    index("search_index_owner_idx").on(t.workspaceId, t.ownerId),
    index("search_index_record_idx").on(t.recordId),
    index("search_index_updated_idx").on(t.workspaceId, t.recordUpdatedAt),
    // Upsert target for "index this record again" — full (not partial) so a
    // soft-deleted row is revived instead of duplicated.
    uniqueIndex("search_index_record_uidx").on(t.workspaceId, t.objectType, t.recordId),
    index("search_index_vector_gin_idx").using("gin", t.searchVector),
  ],
)

export type SearchIndexRow = typeof searchIndex.$inferSelect
export type NewSearchIndexRow = typeof searchIndex.$inferInsert
