import { createEvent, getEventBus } from "@yourcrm/events"
import { ReportEvents } from "@yourcrm/events/src/envelope"
import { requirePermission } from "@yourcrm/permissions"
import {
  assertReportVisible,
  reportPermission,
  resolveReportListScope,
  resolveReportRowScope,
} from "./access"
import {
  createReportSchema,
  reportQuerySchema,
  runReportSchema,
  updateReportSchema,
} from "./schemas"
import type {
  ReportExecutionRequest,
  ReportExecutionResult,
  ReportListResult,
  ReportObjectCatalogEntry,
  ReportRecord,
  ReportsServiceContext,
  ReportsServiceDeps,
} from "./types"

export class ReportNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`report ${id} not found`)
    this.name = "ReportNotFoundError"
  }
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

/**
 * Turn a stored definition into an execution request. Everything the
 * engine reads comes from the saved row; the caller may only narrow the
 * row limit.
 */
function toExecutionRequest(report: ReportRecord, limit?: number): ReportExecutionRequest {
  const savedLimit = typeof report.rowLimit === "number" ? report.rowLimit : null
  const effective =
    limit === undefined ? savedLimit : savedLimit === null ? limit : Math.min(limit, savedLimit)
  return {
    objectType: String(report.objectType ?? ""),
    filter: (report.filter ?? null) as ReportExecutionRequest["filter"],
    groupBy: asNullableString(report.groupBy),
    aggregations: (report.aggregations ?? null) as ReportExecutionRequest["aggregations"],
    columns: (report.columns ?? null) as ReportExecutionRequest["columns"],
    sort: (report.sort ?? null) as ReportExecutionRequest["sort"],
    limit: effective,
  }
}

/**
 * Reports domain service (spec 26-reports, P0), mirroring the `people`
 * reference module.
 *
 * Every method:
 *  1. calls `requirePermission()` FIRST, before any read or write;
 *  2. applies the report's own record-level policy (`access.ts`);
 *  3. does the work through the injected `ReportsStore` port;
 *  4. emits the domain event via the `ReportEvents` constant (never a
 *     literal) and writes the audit row with before/after.
 *
 * `run` additionally derives a `ReportRowScope` from the caller and hands
 * it to the store, so executions return only records that caller may see.
 * `ReportEvents` has no `Deleted` member, so soft-delete and restore emit
 * `Updated` with before/after; the audit row carries the precise action.
 */
export function createReportsService(deps: ReportsServiceDeps) {
  const events = deps.events ?? getEventBus()

  async function loadVisible(
    ctx: ReportsServiceContext,
    id: string,
    action: Parameters<typeof assertReportVisible>[2],
  ): Promise<ReportRecord> {
    const report = await deps.store.findById(ctx.workspaceId, id)
    if (!report) throw new ReportNotFoundError(id)
    assertReportVisible(ctx, report, action)
    return report
  }

  async function list(ctx: ReportsServiceContext, rawQuery: unknown): Promise<ReportListResult> {
    requirePermission(reportPermission(ctx, "read"))
    const query = reportQuerySchema.parse(rawQuery)
    return deps.store.list(ctx.workspaceId, query, resolveReportListScope(ctx))
  }

  async function get(ctx: ReportsServiceContext, id: string): Promise<ReportRecord> {
    requirePermission(reportPermission(ctx, "read"))
    return loadVisible(ctx, id, "read")
  }

  /** Field catalogue for the builder UI. Read permission is enough. */
  function objects(ctx: ReportsServiceContext): ReportObjectCatalogEntry[] {
    requirePermission(reportPermission(ctx, "read"))
    return deps.store.describeObjects()
  }

  async function create(ctx: ReportsServiceContext, rawInput: unknown): Promise<ReportRecord> {
    requirePermission(reportPermission(ctx, "create"))
    const input = createReportSchema.parse(rawInput)
    const report = await deps.store.create(
      ctx.workspaceId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    await events.emit(
      createEvent({
        event: ReportEvents.Created,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "report",
        entityId: report.id,
        after: report,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "report",
      recordId: report.id,
      after: report,
      correlationId: ctx.correlationId,
    })
    return report
  }

  async function update(
    ctx: ReportsServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<ReportRecord> {
    requirePermission(reportPermission(ctx, "update"))
    const patch = updateReportSchema.parse(rawPatch)
    const before = await loadVisible(ctx, id, "update")
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new ReportNotFoundError(id)
    await events.emit(
      createEvent({
        event: ReportEvents.Updated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "report",
        entityId: id,
        before,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "report",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function softDelete(ctx: ReportsServiceContext, id: string): Promise<ReportRecord> {
    requirePermission(reportPermission(ctx, "delete"))
    const before = await loadVisible(ctx, id, "delete")
    await deps.store.softDelete(ctx.workspaceId, id, ctx.actorId)
    await events.emit(
      createEvent({
        event: ReportEvents.Updated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "report",
        entityId: id,
        before,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "report",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function restore(ctx: ReportsServiceContext, id: string): Promise<ReportRecord> {
    requirePermission(reportPermission(ctx, "update"))
    await deps.store.restore(ctx.workspaceId, id)
    const after = await deps.store.findById(ctx.workspaceId, id)
    if (!after) throw new ReportNotFoundError(id)
    assertReportVisible(ctx, after, "update")
    await events.emit(
      createEvent({
        event: ReportEvents.Updated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "report",
        entityId: id,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "restore",
      object: "report",
      recordId: id,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /**
   * Execute a saved report.
   *
   * Three permission gates, in order:
   *  1. `read` on `report` — may the caller use reporting at all;
   *  2. the report's own visibility — may they open THIS definition;
   *  3. `read` on the report's target object — may they read that object.
   * Then the row scope narrows the result set to records the caller may
   * actually see. Reports are never a way around record permissions.
   */
  async function run(
    ctx: ReportsServiceContext,
    id: string,
    rawInput: unknown = {},
  ): Promise<{ report: ReportRecord; result: ReportExecutionResult }> {
    requirePermission(reportPermission(ctx, "read"))
    const input = runReportSchema.parse(rawInput ?? {})
    const report = await loadVisible(ctx, id, "read")
    const objectType = String(report.objectType ?? "")
    requirePermission(reportPermission(ctx, "read", objectType))
    const scope = resolveReportRowScope(ctx)
    const result = await deps.store.execute(
      ctx.workspaceId,
      toExecutionRequest(report, input.limit),
      scope,
    )
    await deps.store.markRun(ctx.workspaceId, id, ctx.actorId)
    await events.emit(
      createEvent({
        event: ReportEvents.Run,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "report",
        entityId: id,
        after: {
          objectType: result.objectType,
          mode: result.mode,
          scope: result.scope,
          rowCount: result.rowCount,
          truncated: result.truncated,
        },
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "run",
      object: "report",
      recordId: id,
      after: {
        objectType: result.objectType,
        mode: result.mode,
        scope: result.scope,
        rowCount: result.rowCount,
        truncated: result.truncated,
      },
      correlationId: ctx.correlationId,
    })
    return { report, result }
  }

  return { list, get, objects, create, update, softDelete, restore, run }
}

export type ReportsService = ReturnType<typeof createReportsService>
