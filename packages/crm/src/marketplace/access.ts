import { checkPermission, PermissionDeniedError, type PermissionAction } from "@yourcrm/permissions"
import type { ServiceContext } from "../index"
import type { AppScope, AppScopeGrant } from "./types"

/**
 * Marketplace scope access policy — the same problem
 * `packages/crm/src/automation/access.ts` solves for workflow automations,
 * solved the same way: two distinct questions, checked in two different
 * places.
 *
 *  1. INSTALL-TIME CAPPING — of what this app's manifest REQUESTS, how much
 *     may actually be granted? Capped by the INSTALLING USER's own live
 *     workspace role, exactly like a workflow inherits its owner's role
 *     (`assertWorkflowActionAllowed`). A viewer who installs an app that
 *     requests `delete` does not hand the app delete — the role-rank gate in
 *     `@yourcrm/permissions` says a viewer cannot delete, so that scope is
 *     silently dropped from the grant set, not silently upgraded.
 *
 *  2. RUN-TIME ENFORCEMENT — of what was actually granted (table
 *     `app_scope_grants`), may this ONE action happen right now?
 *     `assertAppScopeGranted` is the gate: every future call site that acts
 *     "as an app" (a scoped app token, a webhook-triggered callback) must
 *     call this first, before touching any domain service. An app is never
 *     more powerful than its live grants, and grants can only shrink
 *     (uninstall revokes all of them; there is no path that grows a grant
 *     set outside a fresh `install()`).
 *
 * "Whichever is narrower wins" is therefore two independent ceilings:
 * requested-by-manifest (checked once, at install) and
 * granted-in-the-database (checked on every action). Neither check
 * substitutes for the other.
 */

export const MARKETPLACE_APP_OBJECT = "marketplace_app"

/** Split a requested scope list into what the installer's role allows and what it does not. */
export function partitionScopesByInstallerPermission(
  installerCtx: ServiceContext,
  requestedScopes: readonly AppScope[],
): { granted: AppScope[]; denied: AppScope[] } {
  const granted: AppScope[] = []
  const denied: AppScope[] = []
  for (const scope of requestedScopes) {
    const decision = checkPermission({
      workspaceId: installerCtx.workspaceId,
      actorId: installerCtx.actorId,
      role: installerCtx.role ?? "viewer",
      object: scope.object,
      action: scope.action as PermissionAction,
    })
    ;(decision.allowed ? granted : denied).push(scope)
  }
  return { granted, denied }
}

/**
 * THE run-time gate: throws `PermissionDeniedError` unless a LIVE grant for
 * exactly this (object, action) exists on the installation. Callers pass the
 * grants already loaded for the installation (`AppScopeGrantStore.listByInstallation`)
 * — this function does no I/O, so it is trivial to unit test in isolation.
 */
export function assertAppScopeGranted(
  ctx: { workspaceId: string; installationId: string },
  grants: readonly AppScopeGrant[],
  object: string,
  action: string,
): void {
  const hasGrant = grants.some((grant) => grant.object === object && grant.action === action)
  if (hasGrant) return
  throw new PermissionDeniedError(
    {
      workspaceId: ctx.workspaceId,
      actorId: ctx.installationId,
      object,
      action: action as PermissionAction,
    },
    `app installation "${ctx.installationId}" is not granted "${object}:${action}"`,
  )
}
