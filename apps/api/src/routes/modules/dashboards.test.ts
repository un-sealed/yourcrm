import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import { createDashboardsService, type DashboardsService } from "@yourcrm/crm/src/dashboards"
import type {
  DashboardRecord,
  DashboardsStore,
  DashboardWidgetRecord,
} from "@yourcrm/crm/src/dashboards"
import {
  createApiClient,
  createStore,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes } from "./dashboards"

type StoredDashboard = BaseRecord & { name: string; description: string | null }
type StoredWidget = BaseRecord & {
  dashboardId: string
  type: string
  title: string
  positionX: number
  positionY: number
  width: number
  height: number
}

function asDashboard(row: StoredDashboard): DashboardRecord {
  return row as unknown as DashboardRecord
}

function asWidget(row: StoredWidget): DashboardWidgetRecord {
  return row as unknown as DashboardWidgetRecord
}

/** Real domain service over a hermetic in-memory store. */
function makeFakeService() {
  const dashboards = createStore<StoredDashboard>()
  const widgets = createStore<StoredWidget>()
  const liveWidgets = (workspaceId: string, dashboardId: string) =>
    widgets
      .list(workspaceId)
      .filter((w) => w.dashboardId === dashboardId)
      .sort((a, b) => a.positionY - b.positionY || a.positionX - b.positionX)
  const store: DashboardsStore = {
    list: async (workspaceId, query) => {
      const rows = dashboards.list(workspaceId)
      const limit = query.limit ?? 25
      const data = rows.slice(0, limit)
      return {
        data: data.map(asDashboard),
        pagination: {
          nextCursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null,
          limit,
        },
      }
    },
    findById: async (workspaceId, id) => {
      const row = dashboards.get(id, workspaceId)
      return row ? asDashboard(row) : null
    },
    findWithWidgets: async (workspaceId, id) => {
      const row = dashboards.get(id, workspaceId)
      if (!row) return null
      return { dashboard: asDashboard(row), widgets: liveWidgets(workspaceId, id).map(asWidget) }
    },
    create: async (workspaceId, input, actorId) => {
      const dashboard = dashboards.insert({
        ...makeBaseRecord({ workspaceId }),
        name: input.name as string,
        description: null,
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      })
      const created: StoredWidget[] = []
      let bottom = 0
      for (const item of (input.widgets as Record<string, unknown>[]) ?? []) {
        const height = (item.height as number | undefined) ?? 2
        const row = widgets.insert({
          ...makeBaseRecord({ workspaceId }),
          dashboardId: dashboard.id,
          type: item.type as string,
          title: item.title as string,
          positionX: 0,
          positionY: bottom,
          width: (item.width as number | undefined) ?? 4,
          height,
        })
        bottom += height
        created.push(row)
      }
      return { dashboard: asDashboard(dashboard), widgets: created.map(asWidget) }
    },
    update: async (workspaceId, id, input) => {
      const row = dashboards.update(id, workspaceId, input as Partial<StoredDashboard>)
      return row ? asDashboard(row) : null
    },
    softDelete: async (workspaceId, id) => {
      dashboards.remove(id, workspaceId)
    },
    restore: async (workspaceId, id) => {
      dashboards.restore(id, workspaceId)
    },
    addWidget: async (workspaceId, dashboardId, input) => {
      const dashboard = dashboards.get(dashboardId, workspaceId)
      if (!dashboard) return null
      const bottom = liveWidgets(workspaceId, dashboardId).reduce(
        (max, w) => Math.max(max, w.positionY + w.height),
        0,
      )
      return asWidget(
        widgets.insert({
          ...makeBaseRecord({ workspaceId }),
          dashboardId,
          type: input.type as string,
          title: input.title as string,
          positionX: 0,
          positionY: bottom,
          width: (input.width as number | undefined) ?? 4,
          height: (input.height as number | undefined) ?? 2,
        }),
      )
    },
    updateWidget: async (workspaceId, dashboardId, widgetId, input) => {
      const row = widgets.get(widgetId, workspaceId)
      if (!row || row.dashboardId !== dashboardId) return null
      const updated = widgets.update(widgetId, workspaceId, input as Partial<StoredWidget>)
      return updated ? asWidget(updated) : null
    },
    removeWidget: async (workspaceId, dashboardId, widgetId) => {
      const row = widgets.get(widgetId, workspaceId)
      if (!row || row.dashboardId !== dashboardId) return false
      widgets.remove(widgetId, workspaceId)
      return true
    },
    repositionWidget: async (workspaceId, dashboardId, widgetId, input) => {
      const row = widgets.get(widgetId, workspaceId)
      if (!row || row.dashboardId !== dashboardId) return null
      const updated = widgets.update(widgetId, workspaceId, input as Partial<StoredWidget>)
      return updated ? asWidget(updated) : null
    },
  }
  return createDashboardsService({ store, audit: async () => undefined })
}

/**
 * Hermetic API test: the route factory takes a service, so tests inject the
 * real domain service over an in-memory store. Sessions ride a tiny test-only
 * middleware (role-accurate without touching the foundation auth hook).
 */
function makeTestApp(session: { current: Session | null }, service: DashboardsService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/dashboards", createRoutes({ service }))
  return app
}

describe("api/dashboards", () => {
  let session: { current: Session | null }
  let service: DashboardsService
  let ctx: ReturnType<typeof makeServiceContext>

  beforeEach(() => {
    const owner = makeSession({ role: "owner" })
    ctx = makeServiceContext({ session: owner })
    session = { current: owner }
    service = makeFakeService()
  })

  test("unauthenticated requests get UNAUTHORIZED", async () => {
    session.current = null
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/dashboards")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("list returns the cursor pagination envelope", async () => {
    await service.create(ctx, { name: "Sales Overview" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/dashboards")
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("get returns the dashboard with widgets; unknown id is NOT_FOUND", async () => {
    const created = await service.create(ctx, {
      name: "Sales Overview",
      widgets: [{ type: "metric", title: "Open deals" }],
    })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const ok = await api.get(`/api/v1/dashboards/${created.dashboard.id}`)
    expect(ok.status).toBe(200)
    const data = ok.expectSuccess().data as { id: string; widgets: unknown[] }
    expect(data.id).toBe(created.dashboard.id)
    expect(data.widgets).toHaveLength(1)
    const missing = await api.get("/api/v1/dashboards/does-not-exist")
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")
  })

  test("create validates the body and returns 201", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const bad = await api.post("/api/v1/dashboards", { name: "  " })
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")
    const badWidget = await api.post("/api/v1/dashboards", {
      name: "Sales",
      widgets: [{ type: "pie", title: "Bad" }],
    })
    expect(badWidget.status).toBe(400)
    const good = await api.post("/api/v1/dashboards", {
      name: "Sales Overview",
      widgets: [{ type: "metric", title: "Open deals" }],
    })
    expect(good.status).toBe(201)
    expect((good.expectSuccess().data as { name: string }).name).toBe("Sales Overview")
  })

  test("viewer create is FORBIDDEN (service denial maps to 403)", async () => {
    session.current = makeSession({ role: "viewer", workspaceId: ctx.workspaceId })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/dashboards", { name: "Nope" })
    expect(res.status).toBe(403)
    const err = res.expectError("FORBIDDEN")
    expect(err.error.message).toContain("create")
  })

  test("update, delete and restore round-trip", async () => {
    const created = await service.create(ctx, { name: "Sales Overview" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const patched = await api.patch(`/api/v1/dashboards/${created.dashboard.id}`, {
      description: "Weekly",
    })
    expect(patched.status).toBe(200)
    const deleted = await api.delete(`/api/v1/dashboards/${created.dashboard.id}`)
    expect(deleted.status).toBe(200)
    const gone = await api.get(`/api/v1/dashboards/${created.dashboard.id}`)
    expect(gone.status).toBe(404)
    const restored = await api.post(`/api/v1/dashboards/${created.dashboard.id}/restore`)
    expect(restored.status).toBe(200)
    const back = await api.get(`/api/v1/dashboards/${created.dashboard.id}`)
    expect(back.status).toBe(200)
  })

  test("widget endpoints add, update, reposition and remove", async () => {
    const created = await service.create(ctx, {
      name: "Sales Overview",
      widgets: [{ type: "metric", title: "Open deals" }],
    })
    const id = created.dashboard.id
    const api = createApiClient({ app: makeTestApp(session, service) })
    const added = await api.post(`/api/v1/dashboards/${id}/widgets`, {
      type: "bar",
      title: "Pipeline by stage",
    })
    expect(added.status).toBe(201)
    const widgetId = (added.expectSuccess().data as { id: string }).id
    const patched = await api.patch(`/api/v1/dashboards/${id}/widgets/${widgetId}`, {
      title: "Pipeline value by stage",
    })
    expect(patched.status).toBe(200)
    expect((patched.expectSuccess().data as { title: string }).title).toBe(
      "Pipeline value by stage",
    )
    const repositioned = await api.post(`/api/v1/dashboards/${id}/widgets/${widgetId}/reposition`, {
      positionX: 4,
      positionY: 2,
    })
    expect(repositioned.status).toBe(200)
    expect(repositioned.expectSuccess().data).toMatchObject({ positionX: 4, positionY: 2 })
    const removed = await api.delete(`/api/v1/dashboards/${id}/widgets/${widgetId}`)
    expect(removed.status).toBe(200)
    const detail = await api.get(`/api/v1/dashboards/${id}`)
    expect((detail.expectSuccess().data as { widgets: unknown[] }).widgets).toHaveLength(1)
  })

  test("viewer cannot add a widget (service denial maps to 403)", async () => {
    const created = await service.create(ctx, { name: "Sales Overview" })
    session.current = makeSession({ role: "viewer", workspaceId: ctx.workspaceId })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post(`/api/v1/dashboards/${created.dashboard.id}/widgets`, {
      type: "metric",
      title: "Nope",
    })
    expect(res.status).toBe(403)
    res.expectError("FORBIDDEN")
  })
})
