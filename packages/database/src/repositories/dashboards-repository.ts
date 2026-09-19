import { and, asc, eq, ilike, isNull, or, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import {
  dashboardWidgets,
  dashboards,
  isDashboardWidgetType,
  type Dashboard,
  type DashboardWidget,
  type NewDashboard,
} from "../schema/dashboards"
import { createBaseRepository } from "./base-repository"

export type CreateWidgetInput = {
  type: string
  title: string
  positionX?: number | null
  positionY?: number | null
  width?: number | null
  height?: number | null
  reportId?: string | null
  config?: Record<string, unknown> | null
}

export type CreateDashboardInput = {
  name: string
  description?: string | null
  ownerId?: string | null
  widgets?: CreateWidgetInput[]
}

export type UpdateDashboardInput = Partial<Pick<NewDashboard, "name" | "description" | "ownerId">>

export type UpdateWidgetInput = Partial<{
  type: string
  title: string
  positionX: number | null
  positionY: number | null
  width: number | null
  height: number | null
  reportId: string | null
  config: Record<string, unknown> | null
}>

export type RepositionWidgetInput = {
  positionX: number
  positionY: number
  width?: number | null
  height?: number | null
}

export type DashboardWithWidgets = {
  dashboard: Dashboard
  widgets: DashboardWidget[]
}

/** Trimmed, non-empty dashboard name (max 255, mirrors the column). */
export function normalizeDashboardName(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new Error("dashboards.create: name must not be empty")
  if (trimmed.length > 255)
    throw new Error("dashboards.create: name must be at most 255 characters")
  return trimmed
}

/** Trimmed, non-empty widget title (max 255, mirrors the column). */
export function normalizeWidgetTitle(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new Error("dashboards.widget: title must not be empty")
  if (trimmed.length > 255)
    throw new Error("dashboards.widget: title must be at most 255 characters")
  return trimmed
}

export function validateWidgetType(value: unknown): string {
  if (!isDashboardWidgetType(value)) {
    throw new Error("dashboards.widget: type must be one of metric, table, bar, line")
  }
  return value
}

/** Grid coordinate (`positionX` / `positionY`): zero-based, may be 0. */
function validatePosition(
  value: number | null | undefined,
  field: string,
  fallback: number,
): number {
  if (value === null || value === undefined) return fallback
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`dashboards.widget: ${field} must be a non-negative integer`)
  }
  return value
}

/** Grid span (`width` / `height`): at least 1 cell. */
function validateSize(value: number | null | undefined, field: string, fallback: number): number {
  if (value === null || value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`dashboards.widget: ${field} must be a positive integer`)
  }
  return value
}

function toDashboardValues(
  input: CreateDashboardInput | UpdateDashboardInput,
  actorId?: string,
): Partial<NewDashboard> {
  const values: Partial<NewDashboard> = {}
  if (input.name !== undefined) values.name = normalizeDashboardName(input.name)
  if (input.description !== undefined) values.description = input.description?.trim() || null
  if (input.ownerId !== undefined) values.ownerId = input.ownerId
  if (actorId !== undefined) values.updatedBy = actorId
  return values
}

/**
 * Workspace-scoped dashboards + widgets. `reportId` stays a plain column
 * (no join, no import from the reports module) until that module lands.
 */
export function createDashboardsRepository() {
  const base = createBaseRepository(dashboards)

  async function listWidgets(
    db: Database,
    workspaceId: string,
    dashboardId: string,
  ): Promise<DashboardWidget[]> {
    return db
      .select()
      .from(dashboardWidgets)
      .where(
        and(
          eq(dashboardWidgets.dashboardId, dashboardId),
          eq(dashboardWidgets.workspaceId, workspaceId),
          isNull(dashboardWidgets.deletedAt),
        ),
      )
      .orderBy(asc(dashboardWidgets.positionY), asc(dashboardWidgets.positionX))
  }

  /**
   * Widgets stack below the current bottom of the grid when no explicit
   * position is supplied, so "add widget" always lands somewhere sensible.
   */
  async function nextStackPosition(
    db: Database,
    workspaceId: string,
    dashboardId: string,
  ): Promise<{ positionX: number; positionY: number }> {
    const existing = await listWidgets(db, workspaceId, dashboardId)
    const bottom = existing.reduce((max, w) => Math.max(max, w.positionY + w.height), 0)
    return { positionX: 0, positionY: bottom }
  }

  async function insertWidgets(
    db: Database,
    workspaceId: string,
    dashboardId: string,
    items: CreateWidgetInput[],
    actorId?: string,
  ): Promise<DashboardWidget[]> {
    const created: DashboardWidget[] = []
    for (const item of items) {
      const stacked = await nextStackPosition(db, workspaceId, dashboardId)
      const rows = await db
        .insert(dashboardWidgets)
        .values({
          workspaceId,
          dashboardId,
          type: validateWidgetType(item.type),
          title: normalizeWidgetTitle(item.title),
          positionX: validatePosition(item.positionX, "positionX", stacked.positionX),
          positionY: validatePosition(item.positionY, "positionY", stacked.positionY),
          width: validateSize(item.width, "width", 4),
          height: validateSize(item.height, "height", 2),
          reportId: item.reportId ?? null,
          config: item.config ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("dashboards.widget: insert returned no rows")
      created.push(row)
    }
    return created
  }

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateDashboardInput,
      actorId?: string,
    ): Promise<DashboardWithWidgets> {
      const rows = await db
        .insert(dashboards)
        .values({
          ...toDashboardValues(input, actorId),
          workspaceId,
          name: normalizeDashboardName(input.name),
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("dashboards.create: insert returned no rows")
      const widgets = await insertWidgets(db, workspaceId, row.id, input.widgets ?? [], actorId)
      return { dashboard: row, widgets }
    },

    /** Cursor-paginated list with optional case-insensitive name search. */
    async search(
      db: Database,
      opts: { workspaceId: string; limit?: number; cursor?: string; order?: "asc" | "desc" } & {
        query?: string
      },
    ) {
      const conditions: SQL[] = []
      if (opts.query) {
        const q = `%${opts.query.trim()}%`
        const nameMatch = or(ilike(dashboards.name, q), ilike(dashboards.description, q))
        if (nameMatch) conditions.push(nameMatch)
      }
      const result = await base.list(db, { ...opts, where: conditions })
      return { data: result.data as Dashboard[], pagination: result.pagination }
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateDashboardInput,
      actorId?: string,
    ): Promise<Dashboard | null> {
      const rows = await db
        .update(dashboards)
        .set({ ...toDashboardValues(input, actorId), updatedAt: new Date() })
        .where(
          and(
            eq(dashboards.id, id),
            eq(dashboards.workspaceId, workspaceId),
            isNull(dashboards.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    async findById(db: Database, workspaceId: string, id: string): Promise<Dashboard | null> {
      // The shared base narrows rows to the BaseRecord columns; re-select the
      // concrete table here so callers get the full Dashboard shape.
      const row = await base.findById(db, workspaceId, id)
      return (row as Dashboard | null) ?? null
    },

    async findWithWidgets(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<DashboardWithWidgets | null> {
      const dashboard = await this.findById(db, workspaceId, id)
      if (!dashboard) return null
      const widgets = await listWidgets(db, workspaceId, id)
      return { dashboard, widgets }
    },

    async addWidget(
      db: Database,
      workspaceId: string,
      dashboardId: string,
      input: CreateWidgetInput,
      actorId?: string,
    ): Promise<DashboardWidget | null> {
      const dashboard = await this.findById(db, workspaceId, dashboardId)
      if (!dashboard) return null
      const created = await insertWidgets(db, workspaceId, dashboardId, [input], actorId)
      return created[0] ?? null
    },

    async updateWidget(
      db: Database,
      workspaceId: string,
      dashboardId: string,
      widgetId: string,
      input: UpdateWidgetInput,
      actorId?: string,
    ): Promise<DashboardWidget | null> {
      const current = await db
        .select()
        .from(dashboardWidgets)
        .where(
          and(
            eq(dashboardWidgets.id, widgetId),
            eq(dashboardWidgets.dashboardId, dashboardId),
            eq(dashboardWidgets.workspaceId, workspaceId),
            isNull(dashboardWidgets.deletedAt),
          ),
        )
        .limit(1)
      const row = current[0]
      if (!row) return null
      const patch: Partial<DashboardWidget> = {}
      if (input.type !== undefined) patch.type = validateWidgetType(input.type)
      if (input.title !== undefined) patch.title = normalizeWidgetTitle(input.title)
      if (input.positionX !== undefined)
        patch.positionX = validatePosition(input.positionX, "positionX", row.positionX)
      if (input.positionY !== undefined)
        patch.positionY = validatePosition(input.positionY, "positionY", row.positionY)
      if (input.width !== undefined) patch.width = validateSize(input.width, "width", row.width)
      if (input.height !== undefined)
        patch.height = validateSize(input.height, "height", row.height)
      if (input.reportId !== undefined) patch.reportId = input.reportId
      if (input.config !== undefined) patch.config = input.config
      const rows = await db
        .update(dashboardWidgets)
        .set({
          ...patch,
          updatedAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(eq(dashboardWidgets.id, widgetId))
        .returning()
      return rows[0] ?? null
    },

    async removeWidget(
      db: Database,
      workspaceId: string,
      dashboardId: string,
      widgetId: string,
      actorId?: string,
    ): Promise<boolean> {
      const rows = await db
        .update(dashboardWidgets)
        .set({
          deletedAt: new Date(),
          updatedAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(
          and(
            eq(dashboardWidgets.id, widgetId),
            eq(dashboardWidgets.dashboardId, dashboardId),
            eq(dashboardWidgets.workspaceId, workspaceId),
            isNull(dashboardWidgets.deletedAt),
          ),
        )
        .returning({ id: dashboardWidgets.id })
      return (rows.length ?? 0) > 0
    },

    /** Persist a drag-to-reposition result for a single widget's grid cell. */
    async repositionWidget(
      db: Database,
      workspaceId: string,
      dashboardId: string,
      widgetId: string,
      input: RepositionWidgetInput,
      actorId?: string,
    ): Promise<DashboardWidget | null> {
      if (!Number.isInteger(input.positionX) || input.positionX < 0) {
        throw new Error("dashboards.reposition: positionX must be a non-negative integer")
      }
      if (!Number.isInteger(input.positionY) || input.positionY < 0) {
        throw new Error("dashboards.reposition: positionY must be a non-negative integer")
      }
      const current = await db
        .select()
        .from(dashboardWidgets)
        .where(
          and(
            eq(dashboardWidgets.id, widgetId),
            eq(dashboardWidgets.dashboardId, dashboardId),
            eq(dashboardWidgets.workspaceId, workspaceId),
            isNull(dashboardWidgets.deletedAt),
          ),
        )
        .limit(1)
      const row = current[0]
      if (!row) return null
      const rows = await db
        .update(dashboardWidgets)
        .set({
          positionX: input.positionX,
          positionY: input.positionY,
          width: validateSize(input.width, "width", row.width),
          height: validateSize(input.height, "height", row.height),
          updatedAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(eq(dashboardWidgets.id, widgetId))
        .returning()
      return rows[0] ?? null
    },
  }
}

export type DashboardsRepository = ReturnType<typeof createDashboardsRepository>
