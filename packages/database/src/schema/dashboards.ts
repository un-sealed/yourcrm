import { sql } from "drizzle-orm"
import { index, integer, jsonb, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core"
import { baseColumns, ownerColumn, workspaceColumn } from "./base"

/**
 * Dashboards module tables (spec 27-dashboards, P0).
 *
 * - `dashboards`: one row per personal/team dashboard. Workspace scoped,
 *   soft-delete aware, exactly like `people`.
 * - `dashboard_widgets`: tiles placed on a dashboard's grid. `dashboard_id`
 *   references `dashboards (id)` (same-module FK, safe) with cascade
 *   delete. `position_x` / `position_y` / `width` / `height` describe the
 *   widget's cell in the grid and are maintained by the repository via
 *   drag-to-reposition.
 *
 * `report_id` is a PLAIN uuid column with an index and NO foreign key: the
 * reports module (spec 26-reports, slot 0160) is owned by a different
 * module agent working in parallel and its table does not exist in this
 * worktree (same rule as `people.company_id`). Widgets reference a report
 * only as an opaque id — this module never reads/imports the reports
 * module.
 */

export const DASHBOARD_WIDGET_TYPES = ["metric", "table", "bar", "line"] as const

export type DashboardWidgetType = (typeof DASHBOARD_WIDGET_TYPES)[number]

export function isDashboardWidgetType(value: unknown): value is DashboardWidgetType {
  return typeof value === "string" && (DASHBOARD_WIDGET_TYPES as readonly string[]).includes(value)
}

export const dashboards = pgTable(
  "dashboards",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
  },
  (t) => [
    index("dashboards_workspace_idx").on(t.workspaceId),
    index("dashboards_name_idx").on(t.workspaceId, sql`lower(${t.name})`),
  ],
)

export type Dashboard = typeof dashboards.$inferSelect
export type NewDashboard = typeof dashboards.$inferInsert

export const dashboardWidgets = pgTable(
  "dashboard_widgets",
  {
    ...baseColumns,
    ...workspaceColumn,
    dashboardId: uuid("dashboard_id")
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 32 }).notNull().default("metric"),
    title: varchar("title", { length: 255 }).notNull(),
    positionX: integer("position_x").notNull().default(0),
    positionY: integer("position_y").notNull().default(0),
    width: integer("width").notNull().default(4),
    height: integer("height").notNull().default(2),
    // Cross-module reference (plain uuid, NO foreign key — see header).
    reportId: uuid("report_id"),
    config: jsonb("config").$type<Record<string, unknown> | null>(),
  },
  (t) => [
    index("dashboard_widgets_dashboard_idx").on(t.dashboardId),
    index("dashboard_widgets_workspace_idx").on(t.workspaceId),
    index("dashboard_widgets_report_idx").on(t.reportId),
  ],
)

export type DashboardWidget = typeof dashboardWidgets.$inferSelect
export type NewDashboardWidget = typeof dashboardWidgets.$inferInsert
