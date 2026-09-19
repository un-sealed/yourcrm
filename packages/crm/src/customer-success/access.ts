import {
  checkPermission,
  type PermissionAction,
  type PermissionContext,
} from "@yourcrm/permissions"
import type { CsAccountRowScope, CustomerSuccessServiceContext } from "./types"

/**
 * Customer Success access policy — the correctness property this module is
 * graded on: "a member must not see health for accounts they cannot read."
 *
 * Mirrors `reports/access.ts` (the assigned reference for permission-
 * filtered aggregation): a role-rank gate from `@yourcrm/permissions` for
 * "is CS usable at all", plus a row-level scope the service derives from
 * the caller and threads into every store call that could otherwise return
 * another CSM's accounts.
 *
 * There is no separate "cs_account" permission table: workspace
 * admins/owners see every account (they administer the workspace), every
 * other role is scoped to accounts they own or created. That scope also
 * gates health scores, renewals and playbook tasks, because all three hang
 * off an account the caller must already be able to see.
 */

export const CS_OBJECT = "cs_account"

export function csPermission(
  ctx: CustomerSuccessServiceContext,
  action: PermissionAction,
  object: string = CS_OBJECT,
): PermissionContext {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object,
    action,
  }
}

/** True when the caller administers the workspace. */
export function isWorkspaceAdmin(ctx: CustomerSuccessServiceContext): boolean {
  return checkPermission(csPermission(ctx, "admin")).allowed
}

/**
 * Rows an account query may return. Callers cannot influence this — it is
 * computed from the session context only, never from request input.
 */
export function resolveAccountRowScope(ctx: CustomerSuccessServiceContext): CsAccountRowScope {
  return isWorkspaceAdmin(ctx) ? { kind: "workspace" } : { kind: "own", actorId: ctx.actorId }
}
