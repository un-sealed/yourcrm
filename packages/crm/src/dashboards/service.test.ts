import { beforeEach, describe, expect, test } from "bun:test"
import type { ServiceContext } from "../index"
import {
  captureEvents,
  createStore,
  expectAllowed,
  expectDenied,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import {
  createDashboardsService,
  type DashboardRecord,
  type DashboardsService,
  type DashboardsStore,
  type DashboardWidgetRecord,
} from "./index"
import type { DashboardAuditInput, DashboardListQuery } from "./types"

type StoredDashboard = BaseRecord & {
  name: string
  description: string | null
  ownerId: string | null
}

type StoredWidget = BaseRecord & {
  dashboardId: string
  type: string
  title: string
  positionX: number
  positionY: number
  width: number
  height: number
  reportId: string | null
  config: Record<string, unknown> | null
}

function asDashboard(row: StoredDashboard): DashboardRecord {
  return row as unknown as DashboardRecord
}

function asWidget(row: StoredWidget): DashboardWidgetRecord {
  return row as unknown as DashboardWidgetRecord
}

function toStoredWidget(input: Record<string, unknown>, seed: Partial<StoredWidget>): StoredWidget {
  return {
    ...makeBaseRecord({ workspaceId: seed.workspaceId ?? "" }),
    ...seed,
    dashboardId: seed.dashboardId ?? "",
    type: input.type as string,
    title: input.title as string,
    positionX: (input.positionX as number | null | undefined) ?? seed.positionX ?? 0,
    positionY: (input.positionY as number | null | undefined) ?? seed.positionY ?? 0,
    width: (input.width as number | undefined) ?? 4,
    height: (input.height as number | undefined) ?? 2,
    reportId: (input.reportId as string | null | undefined) ?? null,
    config: (input.config as Record<string, unknown> | null | undefined) ?? null,
  } as StoredWidget
}

/** Hermetic DashboardsStore port backed by the shared in-memory stores. */
function makeStore() {
  const dashboards = createStore<StoredDashboard>()
  const widgets = createStore<StoredWidget>()

  const liveWidgets = (workspaceId: string, dashboardId: string) =>
    widgets
      .list(workspaceId)
      .filter((w) => w.dashboardId === dashboardId)
      .sort((a, b) => a.positionY - b.positionY || a.positionX - b.positionX)

  const store: DashboardsStore = {
    list: async (workspaceId: string, query: DashboardListQuery) => {
      let rows = dashboards.list(workspaceId)
      if (query.query) {
        const q = query.query.toLowerCase()
        rows = rows.filter((r) => r.name.toLowerCase().includes(q))
      }
      const limit = Math.min(Math.max(query.limit ?? 25, 1), 200)
      const data = rows.slice(0, limit)
      return {
        data: data.map(asDashboard),
        pagination: {
          nextCursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null,
          limit,
        },
      }
    },
    findById: async (workspaceId: string, id: string) => {
      const row = dashboards.get(id, workspaceId)
      return row ? asDashboard(row) : null
    },
    findWithWidgets: async (workspaceId: string, id: string) => {
      const row = dashboards.get(id, workspaceId)
      if (!row) return null
      return { dashboard: asDashboard(row), widgets: liveWidgets(workspaceId, id).map(asWidget) }
    },
    create: async (workspaceId: string, input: Record<string, unknown>, actorId?: string) => {
      const record: StoredDashboard = {
        ...makeBaseRecord({ workspaceId }),
        name: input.name as string,
        description: (input.description as string | null) ?? null,
        ownerId: (input.ownerId as string | null) ?? null,
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      }
      const dashboard = dashboards.insert(record)
      const createdWidgets: StoredWidget[] = []
      let bottom = 0
      for (const item of (input.widgets as Record<string, unknown>[]) ?? []) {
        const created = widgets.insert(
          toStoredWidget(item, {
            workspaceId,
            dashboardId: dashboard.id,
            positionX: 0,
            positionY: bottom,
          }),
        )
        bottom += created.height
        createdWidgets.push(created)
      }
      return { dashboard: asDashboard(dashboard), widgets: createdWidgets.map(asWidget) }
    },
    update: async (
      workspaceId: string,
      id: string,
      input: Record<string, unknown>,
      _actorId?: string,
    ) => {
      const row = dashboards.update(id, workspaceId, input as Partial<StoredDashboard>)
      return row ? asDashboard(row) : null
    },
    softDelete: async (workspaceId: string, id: string) => {
      dashboards.remove(id, workspaceId)
    },
    restore: async (workspaceId: string, id: string) => {
      dashboards.restore(id, workspaceId)
    },
    addWidget: async (
      workspaceId: string,
      dashboardId: string,
      input: Record<string, unknown>,
      _actorId?: string,
    ) => {
      const dashboard = dashboards.get(dashboardId, workspaceId)
      if (!dashboard) return null
      const bottom = liveWidgets(workspaceId, dashboardId).reduce(
        (max, w) => Math.max(max, w.positionY + w.height),
        0,
      )
      return asWidget(
        widgets.insert(
          toStoredWidget(input, { workspaceId, dashboardId, positionX: 0, positionY: bottom }),
        ),
      )
    },
    updateWidget: async (
      workspaceId: string,
      dashboardId: string,
      widgetId: string,
      input: Record<string, unknown>,
      _actorId?: string,
    ) => {
      const row = widgets.get(widgetId, workspaceId)
      if (!row || row.dashboardId !== dashboardId) return null
      const updated = widgets.update(widgetId, workspaceId, input as Partial<StoredWidget>)
      return updated ? asWidget(updated) : null
    },
    removeWidget: async (workspaceId: string, dashboardId: string, widgetId: string) => {
      const row = widgets.get(widgetId, workspaceId)
      if (!row || row.dashboardId !== dashboardId) return false
      widgets.remove(widgetId, workspaceId)
      return true
    },
    repositionWidget: async (
      workspaceId: string,
      dashboardId: string,
      widgetId: string,
      input: Record<string, unknown>,
      _actorId?: string,
    ) => {
      const row = widgets.get(widgetId, workspaceId)
      if (!row || row.dashboardId !== dashboardId) return null
      const updated = widgets.update(widgetId, workspaceId, input as Partial<StoredWidget>)
      return updated ? asWidget(updated) : null
    },
  }
  return { dashboards, widgets, store }
}

function setup(
  role: "owner" | "admin" | "member" | "viewer" = "owner",
  shared?: ReturnType<typeof makeStore>,
  workspaceId?: string,
) {
  const session = makeSession({ role, ...(workspaceId === undefined ? {} : { workspaceId }) })
  const ctx = makeServiceContext({ session })
  const audits: DashboardAuditInput[] = []
  const backing = shared ?? makeStore()
  const service = createDashboardsService({
    store: backing.store,
    audit: async (input) => void audits.push(input),
  })
  return { ctx, service, audits, session, backing }
}

async function seed(service: DashboardsService, ctx: ServiceContext, name = "Sales Overview") {
  return service.create(ctx, {
    name,
    widgets: [
      { type: "metric", title: "Open deals" },
      { type: "table", title: "Recent activity" },
    ],
  })
}

describe("dashboards/service", () => {
  test("create validates, emits dashboard.created and audits with after", async () => {
    const { ctx, service, audits } = setup()
    const events = captureEvents()
    try {
      const created = await expectAllowed(() => service.create(ctx, { name: "Sales Overview" }))
      expect(created.dashboard.name).toBe("Sales Overview")
      expect(created.widgets).toEqual([])
      events.expectEmitted("dashboard.created", {
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "dashboard",
        entityId: created.dashboard.id,
      })
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({
        workspaceId: ctx.workspaceId,
        action: "create",
        object: "dashboard",
        recordId: created.dashboard.id,
      })
      expect(audits[0]?.after).toMatchObject({ dashboard: { name: "Sales Overview" } })
    } finally {
      events.release()
    }
  })

  test("create rejects invalid input before touching the store", async () => {
    const { ctx, service } = setup()
    await expect(service.create(ctx, { name: "  " })).rejects.toThrow()
  })

  test("create rejects an unknown widget type", async () => {
    const { ctx, service } = setup()
    await expect(
      service.create(ctx, { name: "Sales", widgets: [{ type: "pie", title: "Bad" }] }),
    ).rejects.toThrow()
  })

  test("get returns the dashboard with widgets, list paginates", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const found = await expectAllowed(() => service.get(ctx, created.dashboard.id))
    expect(found.dashboard.id).toBe(created.dashboard.id)
    expect(found.widgets.map((w) => w.title)).toEqual(["Open deals", "Recent activity"])
    const listed = await expectAllowed(() => service.list(ctx, { limit: 25 }))
    expect(listed.data).toHaveLength(1)
    expect(listed.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("get throws NOT_FOUND for unknown ids", async () => {
    const { ctx, service } = setup()
    const err = await service.get(ctx, "missing").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe("NOT_FOUND")
  })

  test("update emits dashboard.updated and audits with before/after", async () => {
    const { ctx, service, audits } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      const updated = await expectAllowed(() =>
        service.update(ctx, created.dashboard.id, { description: "Weekly review" }),
      )
      expect(updated.description).toBe("Weekly review")
      const emitted = events.expectEmitted("dashboard.updated", {
        entityId: created.dashboard.id,
      })
      expect(emitted.before).toMatchObject({ name: "Sales Overview" })
      expect(emitted.after).toMatchObject({ description: "Weekly review" })
      expect(audits.at(-1)).toMatchObject({ action: "update", recordId: created.dashboard.id })
    } finally {
      events.release()
    }
  })

  test("widget CRUD round-trips through the dashboard", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const id = created.dashboard.id
    const widget = await expectAllowed(() =>
      service.addWidget(ctx, id, { type: "bar", title: "Pipeline by stage" }),
    )
    expect(widget.title).toBe("Pipeline by stage")
    const updated = await expectAllowed(() =>
      service.updateWidget(ctx, id, widget.id, { title: "Pipeline value by stage" }),
    )
    expect(updated.title).toBe("Pipeline value by stage")
    await expectAllowed(() => service.removeWidget(ctx, id, widget.id))
    const found = await expectAllowed(() => service.get(ctx, id))
    expect(found.widgets.map((w) => w.id)).not.toContain(widget.id)
  })

  test("repositionWidget persists the new grid cell and emits dashboard.updated", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const id = created.dashboard.id
    const widgetId = created.widgets[0]?.id as string
    const events = captureEvents()
    try {
      const repositioned = await expectAllowed(() =>
        service.repositionWidget(ctx, id, widgetId, { positionX: 4, positionY: 2 }),
      )
      expect(repositioned.positionX).toBe(4)
      expect(repositioned.positionY).toBe(2)
      events.expectEmitted("dashboard.updated", { entityId: id })
    } finally {
      events.release()
    }
  })

  test("repositionWidget throws NOT_FOUND for an unknown widget", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    await expect(
      service.repositionWidget(ctx, created.dashboard.id, "missing", {
        positionX: 0,
        positionY: 0,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  test("softDelete hides the row; restore revives it", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    await expectAllowed(() => service.softDelete(ctx, created.dashboard.id))
    await expect(service.get(ctx, created.dashboard.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    const restored = await expectAllowed(() => service.restore(ctx, created.dashboard.id))
    expect(restored.id).toBe(created.dashboard.id)
    await expectAllowed(() => service.get(ctx, created.dashboard.id))
  })

  describe("denials", () => {
    let backing: ReturnType<typeof makeStore>
    let workspaceId: string
    let dashboardId: string
    let widgetId: string

    function asRole(role: "owner" | "admin" | "member" | "viewer") {
      return setup(role, backing, workspaceId)
    }

    beforeEach(async () => {
      backing = makeStore()
      const owner = setup("owner", backing)
      workspaceId = owner.ctx.workspaceId
      const created = await seed(owner.service, owner.ctx)
      dashboardId = created.dashboard.id
      widgetId = created.widgets[0]?.id as string
    })

    test("viewer cannot create", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.create(ctx, { name: "Nope" }))
    })

    test("viewer cannot update", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.update(ctx, dashboardId, { name: "X" }))
    })

    test("member cannot delete (admin-only)", async () => {
      const { ctx, service } = asRole("member")
      await expectDenied(() => service.softDelete(ctx, dashboardId))
    })

    test("viewer cannot add a widget", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.addWidget(ctx, dashboardId, { type: "metric", title: "X" }))
    })

    test("viewer cannot reposition a widget", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() =>
        service.repositionWidget(ctx, dashboardId, widgetId, { positionX: 0, positionY: 0 }),
      )
    })

    test("viewer can still list and get (read is open)", async () => {
      const { ctx, service } = asRole("viewer")
      await expectAllowed(() => service.list(ctx, {}))
      await expectAllowed(() => service.get(ctx, dashboardId))
    })
  })
})
