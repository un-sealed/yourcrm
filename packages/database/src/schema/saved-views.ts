import { boolean, index, jsonb, pgTable, varchar } from "drizzle-orm/pg-core"
import { baseColumns, ownerColumn, workspaceColumn } from "./base"

/**
 * Filter tree stored as plain JSON. The UI agent owns the rich FilterBuilder
 * component types; this shape is the persistence contract both sides honor:
 *
 *   group = { op: "and" | "or", conditions: FilterNode[] }
 *   leaf  = { field: string, operator: string, value?: unknown }
 *
 * Supported leaf operators: eq, neq, contains, not_contains, starts_with,
 * ends_with, gt, gte, lt, lte, between, in, not_in, is_null, is_not_null.
 * The root node should always be a group. `value` is omitted for
 * is_null / is_not_null. Deliberately no import from `@yourcrm/ui` here —
 * the UI agent's exported filter type is reconciled at integration.
 */
export type SavedViewFilterNode =
  | { op: "and" | "or"; conditions: SavedViewFilterNode[] }
  | { field: string; operator: string; value?: unknown }

/** Column layout stored as plain JSON: ordered visible columns + widths. */
export type SavedViewColumnConfig = { key: string; width?: number; visible?: boolean }[]

/** Sort stored as plain JSON: ordered (field, direction) pairs. */
export type SavedViewSortConfig = { field: string; direction: "asc" | "desc" }[]

/**
 * Named, reusable record list configuration per object (`object_type` is the
 * object key, e.g. "person", "deal"). Personal views carry `owner_id`;
 * `is_shared` exposes a view to the whole workspace. `filter`/`columns`/
 * `sort` are schemaless JSON validated at the repository boundary.
 */
export const savedViews = pgTable(
  "saved_views",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    objectType: varchar("object_type", { length: 64 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    isShared: boolean("is_shared").notNull().default(false),
    filter: jsonb("filter").$type<SavedViewFilterNode | null>(),
    columns: jsonb("columns").$type<SavedViewColumnConfig | null>(),
    sort: jsonb("sort").$type<SavedViewSortConfig | null>(),
  },
  (t) => [
    index("saved_views_workspace_object_idx").on(t.workspaceId, t.objectType),
    index("saved_views_owner_idx").on(t.ownerId),
  ],
)

export type SavedView = typeof savedViews.$inferSelect
export type NewSavedView = typeof savedViews.$inferInsert
