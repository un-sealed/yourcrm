import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import {
  dashboardWidgets,
  dashboards,
  type Dashboard,
  type DashboardWidget,
} from "../schema/dashboards"
import {
  createDashboardsRepository,
  normalizeDashboardName,
  normalizeWidgetTitle,
  validateWidgetType,
} from "./dashboards-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const DASHBOARD_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const WIDGET_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const MIGRATION = new URL("../../migrations/0170_dashboards.sql", import.meta.url)

/** Thenable chain stub: every query builder call returns the proxy; each await pops one result. */
function mockDb(queued: unknown[][] = []) {
  let step = 0
  const proxy = new Proxy(function () {}, {
    get(_target, prop: string | symbol) {
      if (prop === "then") {
        return (resolve: (value: unknown) => void) => {
          resolve(queued[step] ?? [])
          step += 1
        }
      }
      return (..._args: unknown[]) => proxy
    },
  })
  return proxy as unknown as Database
}

function makeDashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    id: DASHBOARD_ID,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    ownerId: null,
    name: "Sales Overview",
    description: null,
    ...overrides,
  }
}

function makeWidget(overrides: Partial<DashboardWidget> = {}): DashboardWidget {
  return {
    id: WIDGET_ID,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    dashboardId: DASHBOARD_ID,
    type: "metric",
    title: "Open deals",
    positionX: 0,
    positionY: 0,
    width: 4,
    height: 2,
    reportId: null,
    config: null,
    ...overrides,
  }
}

describe("dashboards/schema", () => {
  test("dashboards expose the BaseRecord column contract", () => {
    const cols = dashboards as unknown as Record<string, unknown>
    for (const col of ["id", "workspaceId", "createdAt", "updatedAt", "deletedAt"]) {
      expect(cols[col], col).toBeDefined()
    }
    expect(cols.name).toBeDefined()
    expect(cols.ownerId).toBeDefined()
  })

  test("dashboard_widgets carry a dashboard FK, grid position and opaque report id", () => {
    const cols = dashboardWidgets as unknown as Record<string, unknown>
    expect(cols.dashboardId).toBeDefined()
    expect(cols.workspaceId).toBeDefined()
    expect(cols.positionX).toBeDefined()
    expect(cols.positionY).toBeDefined()
    expect(cols.width).toBeDefined()
    expect(cols.height).toBeDefined()
    expect(cols.reportId).toBeDefined()
  })
})

describe("dashboards/validation", () => {
  test("names trim and collapse whitespace", () => {
    expect(normalizeDashboardName("  Sales   Overview ")).toBe("Sales Overview")
  })

  test("names reject empty and overlong values", () => {
    expect(() => normalizeDashboardName("   ")).toThrow()
    expect(() => normalizeDashboardName("x".repeat(256))).toThrow()
  })

  test("widget titles trim and collapse whitespace", () => {
    expect(normalizeWidgetTitle("  Open   Deals ")).toBe("Open Deals")
  })

  test("widget titles reject empty values", () => {
    expect(() => normalizeWidgetTitle("   ")).toThrow()
  })

  test("widget type must be one of the P0 set", () => {
    expect(validateWidgetType("bar")).toBe("bar")
    expect(() => validateWidgetType("pie")).toThrow(/metric, table, bar, line/)
  })
})

describe("dashboards/repository", () => {
  test("create returns the inserted dashboard with no widgets", async () => {
    const repo = createDashboardsRepository()
    const row = makeDashboard()
    const result = await repo.create(mockDb([[row]]), WS, { name: "Sales Overview" })
    expect(result.dashboard).toBe(row)
    expect(result.widgets).toEqual([])
  })

  test("create rejects empty names before touching the db", async () => {
    const repo = createDashboardsRepository()
    await expect(repo.create(mockDb(), WS, { name: "  " })).rejects.toThrow()
  })

  test("create surfaces empty insert results as errors", async () => {
    const repo = createDashboardsRepository()
    await expect(repo.create(mockDb([[]]), WS, { name: "Sales Overview" })).rejects.toThrow()
  })

  test("create inserts widgets stacked below one another", async () => {
    const repo = createDashboardsRepository()
    const dashboardRow = makeDashboard()
    const widgetRow = makeWidget()
    // step 0: insert dashboard -> [dashboardRow]
    // step 1: list existing widgets (stacking lookup) -> []
    // step 2: insert widget -> [widgetRow]
    const result = await repo.create(mockDb([[dashboardRow], [], [widgetRow]]), WS, {
      name: "Sales Overview",
      widgets: [{ type: "metric", title: "Open deals" }],
    })
    expect(result.widgets).toEqual([widgetRow])
  })

  test("create rejects an unknown widget type", async () => {
    const repo = createDashboardsRepository()
    const dashboardRow = makeDashboard()
    await expect(
      repo.create(mockDb([[dashboardRow], []]), WS, {
        name: "Sales Overview",
        widgets: [{ type: "pie" as never, title: "Bad" }],
      }),
    ).rejects.toThrow(/metric, table, bar, line/)
  })

  test("search returns the cursor pagination envelope", async () => {
    const repo = createDashboardsRepository()
    const rows = [
      makeDashboard({ id: "id-1" }),
      makeDashboard({ id: "id-2" }),
      makeDashboard({ id: "id-3" }),
    ]
    const result = await repo.search(mockDb([rows]), { workspaceId: WS, limit: 2, query: "sales" })
    expect(result.data).toHaveLength(2)
    expect(result.pagination).toEqual({ nextCursor: "id-2", limit: 2 })
  })

  test("update returns null when the row is missing", async () => {
    const repo = createDashboardsRepository()
    await expect(repo.update(mockDb([[]]), WS, "missing", { name: "Renamed" })).resolves.toBeNull()
  })

  test("findWithWidgets returns null when the dashboard is missing", async () => {
    const repo = createDashboardsRepository()
    await expect(repo.findWithWidgets(mockDb([[]]), WS, "missing")).resolves.toBeNull()
  })

  test("findWithWidgets returns the dashboard plus its widgets", async () => {
    const repo = createDashboardsRepository()
    const dashboardRow = makeDashboard()
    const widgetRow = makeWidget()
    const result = await repo.findWithWidgets(
      mockDb([[dashboardRow], [widgetRow]]),
      WS,
      DASHBOARD_ID,
    )
    expect(result?.dashboard).toBe(dashboardRow)
    expect(result?.widgets).toEqual([widgetRow])
  })

  test("addWidget returns null when the dashboard is missing", async () => {
    const repo = createDashboardsRepository()
    await expect(
      repo.addWidget(mockDb([[]]), WS, "missing", { type: "metric", title: "X" }),
    ).resolves.toBeNull()
  })

  test("updateWidget returns null when the widget is missing", async () => {
    const repo = createDashboardsRepository()
    await expect(
      repo.updateWidget(mockDb([[]]), WS, DASHBOARD_ID, "missing", { title: "X" }),
    ).resolves.toBeNull()
  })

  test("repositionWidget rejects negative coordinates before touching the db", async () => {
    const repo = createDashboardsRepository()
    await expect(
      repo.repositionWidget(mockDb(), WS, DASHBOARD_ID, WIDGET_ID, { positionX: -1, positionY: 0 }),
    ).rejects.toThrow(/positionX/)
  })

  test("repositionWidget returns null when the widget is missing", async () => {
    const repo = createDashboardsRepository()
    await expect(
      repo.repositionWidget(mockDb([[]]), WS, DASHBOARD_ID, "missing", {
        positionX: 1,
        positionY: 2,
      }),
    ).resolves.toBeNull()
  })

  test("removeWidget reports whether a live row was soft-deleted", async () => {
    const repo = createDashboardsRepository()
    const removed = await repo.removeWidget(
      mockDb([[{ id: WIDGET_ID }]]),
      WS,
      DASHBOARD_ID,
      WIDGET_ID,
    )
    expect(removed).toBe(true)
    const missed = await repo.removeWidget(mockDb([[]]), WS, DASHBOARD_ID, "missing")
    expect(missed).toBe(false)
  })
})

describe("dashboards/migration", () => {
  test("0170 creates dashboards plus dashboard_widgets with the agreed indexes", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS dashboards")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS dashboard_widgets")
    expect(sql).toContain("dashboard_widgets_dashboard_idx")
    expect(sql).toContain("dashboard_widgets_report_idx")
    expect(sql).toContain("REFERENCES dashboards (id) ON DELETE CASCADE")
  })

  test("report_id stays FK-free", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const block = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS dashboard_widgets"))
    expect(block).toContain("report_id UUID")
    expect(block).not.toContain("REFERENCES reports")
  })
})
