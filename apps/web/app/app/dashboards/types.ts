/** Widget kinds shipped in P0 (spec 27-dashboards). */
export const WIDGET_TYPES = ["metric", "table", "bar", "line"] as const

export type WidgetType = (typeof WIDGET_TYPES)[number]

export const WIDGET_TYPE_OPTIONS: { value: WidgetType; label: string }[] = [
  { value: "metric", label: "Metric" },
  { value: "table", label: "Table" },
  { value: "bar", label: "Bar chart" },
  { value: "line", label: "Line chart" },
]

/**
 * Widget-specific display config. Kept loose (`Record<string, unknown>`)
 * because P0 has no report data source wired up yet — a widget's `reportId`
 * is an opaque reference to the reports module (owned by a different
 * agent), and `config` holds the P0 preview data an editor can type in by
 * hand until report execution lands.
 */
export type MetricWidgetConfig = { value?: number; unit?: string }
export type TableWidgetConfig = { columns?: string[]; rows?: string[][] }
export type SeriesWidgetConfig = { series?: { label: string; value: number }[] }

/** Dashboard widget as returned by the dashboards API (envelope `data` item). */
export type DashboardWidget = {
  id: string
  dashboardId: string
  type: WidgetType
  title: string
  positionX: number
  positionY: number
  width: number
  height: number
  reportId: string | null
  config: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

/** Dashboard record as returned by `GET /api/v1/dashboards` (envelope `data` item). */
export type Dashboard = {
  id: string
  workspaceId: string
  name: string
  description: string | null
  ownerId: string | null
  createdAt: string
  updatedAt: string
}

export type DashboardDetail = Dashboard & {
  widgets: DashboardWidget[]
}

export type DashboardsListResponse = {
  data: Dashboard[]
  pagination: { nextCursor: string | null; limit: number }
}

export const GRID_COLUMNS = 12
