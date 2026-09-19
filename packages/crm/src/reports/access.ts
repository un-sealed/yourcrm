import {
  checkPermission,
  PermissionDeniedError,
  type PermissionAction,
  type PermissionContext,
} from "@yourcrm/permissions"
import type { ReportListScope, ReportRecord, ReportRowScope, ReportsServiceContext } from "./types"

/**
 * Report access policy.
 *
 * This layers record- and row-level rules ON TOP of the shared foundation
 * policy in `@yourcrm/permissions` — it never replaces it and never invents
 * a second role model: every decision here is expressed with
 * `checkPermission` / `PermissionDeniedError` from that package.
 *
 * Two independent gates:
 *
 *  1. DEFINITION visibility — who may open, run, edit or delete a saved
 *     report. A `private` report belongs to its owner (and workspace
 *     admins); `shared` reports are visible workspace-wide.
 *  2. RESULT ROW visibility — which underlying records an execution may
 *     return. Workspace admins/owners see the whole workspace; everyone
 *     else only sees records they own, are assigned or created. This is
 *     what stops a report from becoming a permission bypass: the answer to
 *     "how many deals are there" depends on who is asking.
 */

export const REPORT_OBJECT = "report"

export function reportPermission(
  ctx: ReportsServiceContext,
  action: PermissionAction,
  object: string = REPORT_OBJECT,
): PermissionContext {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object,
    action,
  }
}

/**
 * True when the caller administers the workspace. Derived from the shared
 * policy (`admin` action), so role ranks stay defined in one place.
 */
export function isWorkspaceAdmin(ctx: ReportsServiceContext): boolean {
  return checkPermission(reportPermission(ctx, "admin")).allowed
}

function actorOwns(ctx: ReportsServiceContext, report: ReportRecord): boolean {
  const ownerId = report.ownerId
  const createdBy = report.createdBy
  return (
    (typeof ownerId === "string" && ownerId === ctx.actorId) ||
    (typeof createdBy === "string" && createdBy === ctx.actorId)
  )
}

/**
 * Rows an execution may return. Admins and owners see the workspace;
 * everyone else is narrowed to their own records. Callers cannot influence
 * this — it is computed from the session context only.
 */
export function resolveReportRowScope(ctx: ReportsServiceContext): ReportRowScope {
  return isWorkspaceAdmin(ctx) ? { kind: "workspace" } : { kind: "own", actorId: ctx.actorId }
}

/** Saved definitions a caller may list: all of them, or shared + own. */
export function resolveReportListScope(ctx: ReportsServiceContext): ReportListScope {
  return isWorkspaceAdmin(ctx) ? { kind: "all" } : { kind: "visible", actorId: ctx.actorId }
}

/**
 * Record-level gate for one saved definition. Throws the shared
 * `PermissionDeniedError` (so `expectDenied` and the route's 403 mapping
 * both recognise it) when a private report belongs to somebody else.
 */
export function assertReportVisible(
  ctx: ReportsServiceContext,
  report: ReportRecord,
  action: PermissionAction,
): void {
  if (report.visibility !== "private") return
  if (isWorkspaceAdmin(ctx) || actorOwns(ctx, report)) return
  throw new PermissionDeniedError(
    { ...reportPermission(ctx, action), recordId: report.id },
    "this report is private to its owner",
  )
}
