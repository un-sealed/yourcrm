import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"

/**
 * Dashboards service ports (mirrors `people/types.ts`).
 *
 * `@yourcrm/crm` has no database dependency, so the service never imports
 * `@yourcrm/database`. It depends on these structural ports instead; the API
 * layer adapts the drizzle repository (`dashboards-repository.ts`) and
 * `writeAudit` to them. Any object with matching methods satisfies the
 * port — including the `createStore` fake in hermetic tests.
 *
 * A widget's `reportId` is an opaque uuid: this module never imports from
 * (or depends on the existence of) `packages/crm/src/reports/` — that
 * module is owned by a different agent and is not part of this worktree.
 */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type DashboardRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
}

export type DashboardWidgetRecord = Record<string, unknown> & {
  id: string
  dashboardId: string
  type: string
  title: string
  positionX: number
  positionY: number
  width: number
  height: number
}

export type DashboardWithWidgets = {
  dashboard: DashboardRecord
  widgets: DashboardWidgetRecord[]
}

export type DashboardListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
}

export type DashboardListResult = {
  data: DashboardRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type DashboardsStore = {
  list(workspaceId: string, query: DashboardListQuery): Promise<DashboardListResult>
  findById(workspaceId: string, id: string): Promise<DashboardRecord | null>
  findWithWidgets(workspaceId: string, id: string): Promise<DashboardWithWidgets | null>
  create(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<DashboardWithWidgets>
  update(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<DashboardRecord | null>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  restore(workspaceId: string, id: string): Promise<void>
  addWidget(
    workspaceId: string,
    dashboardId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<DashboardWidgetRecord | null>
  updateWidget(
    workspaceId: string,
    dashboardId: string,
    widgetId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<DashboardWidgetRecord | null>
  removeWidget(workspaceId: string, dashboardId: string, widgetId: string): Promise<boolean>
  repositionWidget(
    workspaceId: string,
    dashboardId: string,
    widgetId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<DashboardWidgetRecord | null>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type DashboardAuditInput = {
  workspaceId: string
  actorId?: string | null
  action: string
  object: string
  recordId?: string | null
  before?: unknown
  after?: unknown
  correlationId?: string | null
  source?: "user" | "automation" | "ai" | "integration" | "mcp"
}

export type DashboardsServiceContext = ServiceContext

export type DashboardsServiceDeps = {
  store: DashboardsStore
  audit: AuditWriter<DashboardAuditInput>
  events?: EventEmitter
}
