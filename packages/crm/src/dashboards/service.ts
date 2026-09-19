import { createEvent, getEventBus } from "@yourcrm/events"
// `DashboardEvents` is defined in the events envelope but not re-exported
// from the package barrel (centrally owned, same gap `invoices/service.ts`
// works around); import the canonical constant from its defining module
// rather than repeating the strings locally.
import { DashboardEvents } from "@yourcrm/events/src/envelope"
import { requirePermission } from "@yourcrm/permissions"
import {
  createDashboardSchema,
  createWidgetSchema,
  dashboardQuerySchema,
  repositionWidgetSchema,
  updateDashboardSchema,
  updateWidgetSchema,
} from "./schemas"
import type {
  DashboardListResult,
  DashboardRecord,
  DashboardWidgetRecord,
  DashboardWithWidgets,
  DashboardsServiceContext,
  DashboardsServiceDeps,
} from "./types"

export class DashboardNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`dashboard ${id} not found`)
    this.name = "DashboardNotFoundError"
  }
}

export class DashboardWidgetNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`dashboard widget ${id} not found`)
    this.name = "DashboardWidgetNotFoundError"
  }
}

function permissionOf(
  ctx: DashboardsServiceContext,
  action: "read" | "create" | "update" | "delete",
) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "dashboard",
    action,
  }
}

/**
 * Dashboards domain service (mirrors `people/service.ts` and
 * `pipelines/service.ts` for the widget sub-resource shape).
 *
 * Every method:
 *  1. calls `requirePermission()` FIRST, before any read or write;
 *  2. does the work through the injected `DashboardsStore` port;
 *  3. emits the domain event via the `DashboardEvents` constant (never a
 *     literal);
 *  4. writes the audit row with before/after (mutations only).
 *
 * Only `dashboard.created` / `dashboard.updated` exist in the event catalog
 * (spec 27-dashboards section 9) — widget mutations (add/update/remove/
 * reposition) reuse `DashboardEvents.Updated`, same as pipeline stage
 * mutations reuse `PipelineEvents.PipelineUpdated`.
 */
export function createDashboardsService(deps: DashboardsServiceDeps) {
  const events = deps.events ?? getEventBus()

  async function emitAndAudit(input: {
    event: string
    ctx: DashboardsServiceContext
    entityId: string
    action: string
    before?: unknown
    after?: unknown
  }): Promise<void> {
    await events.emit(
      createEvent({
        event: input.event,
        workspaceId: input.ctx.workspaceId,
        actorId: input.ctx.actorId,
        entityType: "dashboard",
        entityId: input.entityId,
        before: input.before,
        after: input.after,
        correlationId: input.ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: input.ctx.workspaceId,
      actorId: input.ctx.actorId,
      action: input.action,
      object: "dashboard",
      recordId: input.entityId,
      before: input.before,
      after: input.after,
      correlationId: input.ctx.correlationId,
    })
  }

  async function list(
    ctx: DashboardsServiceContext,
    rawQuery: unknown,
  ): Promise<DashboardListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = dashboardQuerySchema.parse(rawQuery)
    return deps.store.list(ctx.workspaceId, query)
  }

  async function get(ctx: DashboardsServiceContext, id: string): Promise<DashboardWithWidgets> {
    requirePermission(permissionOf(ctx, "read"))
    const found = await deps.store.findWithWidgets(ctx.workspaceId, id)
    if (!found) throw new DashboardNotFoundError(id)
    return found
  }

  async function create(
    ctx: DashboardsServiceContext,
    rawInput: unknown,
  ): Promise<DashboardWithWidgets> {
    requirePermission(permissionOf(ctx, "create"))
    const input = createDashboardSchema.parse(rawInput)
    const created = await deps.store.create(
      ctx.workspaceId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    await emitAndAudit({
      event: DashboardEvents.Created,
      ctx,
      entityId: created.dashboard.id,
      action: "create",
      after: created,
    })
    return created
  }

  async function update(
    ctx: DashboardsServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<DashboardRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const patch = updateDashboardSchema.parse(rawPatch)
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new DashboardNotFoundError(id)
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new DashboardNotFoundError(id)
    await emitAndAudit({
      event: DashboardEvents.Updated,
      ctx,
      entityId: id,
      action: "update",
      before,
      after,
    })
    return after
  }

  async function softDelete(ctx: DashboardsServiceContext, id: string): Promise<DashboardRecord> {
    requirePermission(permissionOf(ctx, "delete"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new DashboardNotFoundError(id)
    await deps.store.softDelete(ctx.workspaceId, id, ctx.actorId)
    await emitAndAudit({
      event: DashboardEvents.Updated,
      ctx,
      entityId: id,
      action: "delete",
      before,
    })
    return before
  }

  async function restore(ctx: DashboardsServiceContext, id: string): Promise<DashboardRecord> {
    requirePermission(permissionOf(ctx, "update"))
    await deps.store.restore(ctx.workspaceId, id)
    const after = await deps.store.findById(ctx.workspaceId, id)
    if (!after) throw new DashboardNotFoundError(id)
    await emitAndAudit({
      event: DashboardEvents.Updated,
      ctx,
      entityId: id,
      action: "restore",
      after,
    })
    return after
  }

  async function addWidget(
    ctx: DashboardsServiceContext,
    dashboardId: string,
    rawInput: unknown,
  ): Promise<DashboardWidgetRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const input = createWidgetSchema.parse(rawInput)
    const widget = await deps.store.addWidget(
      ctx.workspaceId,
      dashboardId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    if (!widget) throw new DashboardNotFoundError(dashboardId)
    await emitAndAudit({
      event: DashboardEvents.Updated,
      ctx,
      entityId: dashboardId,
      action: "widget_create",
      after: widget,
    })
    return widget
  }

  async function updateWidget(
    ctx: DashboardsServiceContext,
    dashboardId: string,
    widgetId: string,
    rawPatch: unknown,
  ): Promise<DashboardWidgetRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const patch = updateWidgetSchema.parse(rawPatch)
    const before = await get(ctx, dashboardId)
    const existing = before.widgets.find((w) => w.id === widgetId)
    if (!existing) throw new DashboardWidgetNotFoundError(widgetId)
    const after = await deps.store.updateWidget(
      ctx.workspaceId,
      dashboardId,
      widgetId,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new DashboardWidgetNotFoundError(widgetId)
    await emitAndAudit({
      event: DashboardEvents.Updated,
      ctx,
      entityId: dashboardId,
      action: "widget_update",
      before: existing,
      after,
    })
    return after
  }

  async function removeWidget(
    ctx: DashboardsServiceContext,
    dashboardId: string,
    widgetId: string,
  ): Promise<void> {
    requirePermission(permissionOf(ctx, "update"))
    const before = await get(ctx, dashboardId)
    const existing = before.widgets.find((w) => w.id === widgetId)
    if (!existing) throw new DashboardWidgetNotFoundError(widgetId)
    await deps.store.removeWidget(ctx.workspaceId, dashboardId, widgetId)
    await emitAndAudit({
      event: DashboardEvents.Updated,
      ctx,
      entityId: dashboardId,
      action: "widget_delete",
      before: existing,
    })
  }

  /** Persist a drag-to-reposition result for one widget's grid cell. */
  async function repositionWidget(
    ctx: DashboardsServiceContext,
    dashboardId: string,
    widgetId: string,
    rawInput: unknown,
  ): Promise<DashboardWidgetRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const input = repositionWidgetSchema.parse(rawInput)
    const before = await get(ctx, dashboardId)
    const existing = before.widgets.find((w) => w.id === widgetId)
    if (!existing) throw new DashboardWidgetNotFoundError(widgetId)
    const after = await deps.store.repositionWidget(
      ctx.workspaceId,
      dashboardId,
      widgetId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new DashboardWidgetNotFoundError(widgetId)
    await emitAndAudit({
      event: DashboardEvents.Updated,
      ctx,
      entityId: dashboardId,
      action: "widget_reposition",
      before: existing,
      after,
    })
    return after
  }

  return {
    list,
    get,
    create,
    update,
    softDelete,
    restore,
    addWidget,
    updateWidget,
    removeWidget,
    repositionWidget,
  }
}

export type DashboardsService = ReturnType<typeof createDashboardsService>
