import { index, integer, jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core"
import { baseColumns, ownerColumn, workspaceColumn } from "./base"

/**
 * Reports module tables (spec 26-reports, P0).
 *
 * A report is a *saved definition*, not a materialised result: which object
 * to read, how to filter/group/aggregate/sort it and which columns to show.
 * Execution happens on demand in `repositories/reports-repository.ts`, and
 * the rows it returns are always scoped to the calling actor (see
 * `ReportRowScope` there). Charts are deliberately out of scope — the
 * dashboards module owns visualisation; P0 reports render tables.
 *
 * `owner_id` and `created_by` stay PLAIN uuid columns with NO foreign key:
 * `users` is created by an earlier migration but reports must not couple to
 * another module's table (same rule as `people.company_id`, 0010_people.sql).
 */

/**
 * Persistence mirror of the `FilterTree` exported by `@yourcrm/ui`
 * (`packages/ui/src/filter-builder.tsx`). There is exactly ONE filter model
 * in the product: the builder's. `@yourcrm/database` is infrastructure and
 * must not import UI, so the shape is restated here and validated
 * structurally at the repository boundary — never widened or re-invented.
 *
 *   group     = { type: "group", id, combinator: "and" | "or", children: [] }
 *   condition = { type: "condition", id, field, operator, value }
 *
 * `saved_views.filter` stores the same idea in its own legacy `{ op,
 * conditions }` encoding; reports stay with the builder's encoding so the
 * web builder round-trips without a translation layer.
 */
export type ReportFilterCondition = {
  type: "condition"
  id: string
  field: string
  operator: string
  value?: unknown
}

export type ReportFilterGroup = {
  type: "group"
  id: string
  combinator: "and" | "or"
  children: ReportFilterNode[]
}

export type ReportFilterNode = ReportFilterCondition | ReportFilterGroup

/** Root of a stored filter is always a group (possibly empty = match all). */
export type ReportFilterTree = ReportFilterGroup

export const REPORT_AGGREGATE_FUNCTIONS = ["count", "sum", "avg", "min", "max"] as const

export type ReportAggregateFunction = (typeof REPORT_AGGREGATE_FUNCTIONS)[number]

export function isReportAggregateFunction(value: unknown): value is ReportAggregateFunction {
  return (
    typeof value === "string" && (REPORT_AGGREGATE_FUNCTIONS as readonly string[]).includes(value)
  )
}

/**
 * One metric column. `field` is omitted for `count` (row count); every other
 * function needs a numeric/date field from the object's allowlist.
 */
export type ReportAggregationConfig = {
  fn: ReportAggregateFunction
  field?: string | null
  label?: string | null
}

/** Ordered visible columns for table output (detail mode). */
export type ReportColumnConfig = { field: string; label?: string | null }[]

/** Ordered (field, direction) pairs — same encoding as `saved_views.sort`. */
export type ReportSortConfig = { field: string; direction: "asc" | "desc" }[]

export const REPORT_VISIBILITIES = ["private", "shared"] as const

export type ReportVisibility = (typeof REPORT_VISIBILITIES)[number]

export function isReportVisibility(value: unknown): value is ReportVisibility {
  return typeof value === "string" && (REPORT_VISIBILITIES as readonly string[]).includes(value)
}

/** Hard ceiling on rows returned by one execution (spec 17: bounded reads). */
export const REPORT_MAX_ROW_LIMIT = 500

export const REPORT_DEFAULT_ROW_LIMIT = 100

export const reports = pgTable(
  "reports",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    /** Reportable object key, e.g. "person" — see REPORT_OBJECTS. */
    objectType: varchar("object_type", { length: 64 }).notNull(),
    visibility: varchar("visibility", { length: 32 }).notNull().default("shared"),
    filter: jsonb("filter").$type<ReportFilterTree | null>(),
    groupBy: varchar("group_by", { length: 128 }),
    aggregations: jsonb("aggregations").$type<ReportAggregationConfig[] | null>(),
    columns: jsonb("columns").$type<ReportColumnConfig | null>(),
    sort: jsonb("sort").$type<ReportSortConfig | null>(),
    rowLimit: integer("row_limit").notNull().default(REPORT_DEFAULT_ROW_LIMIT),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  },
  (t) => [
    index("reports_workspace_idx").on(t.workspaceId),
    index("reports_workspace_object_idx").on(t.workspaceId, t.objectType),
    index("reports_owner_idx").on(t.ownerId),
    index("reports_visibility_idx").on(t.workspaceId, t.visibility),
  ],
)

export type Report = typeof reports.$inferSelect
export type NewReport = typeof reports.$inferInsert
