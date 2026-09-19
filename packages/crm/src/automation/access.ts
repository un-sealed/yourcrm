import {
  PermissionDeniedError,
  requirePermission,
  type PermissionAction,
  type PermissionContext,
} from "@yourcrm/permissions"
import type { ServiceContext } from "../index"
import type { WorkflowActionType } from "./schemas"
import type { WorkflowActionTarget } from "./types"

/**
 * Workflow automation access policy.
 *
 * Two distinct questions, answered in two different places, and confusing
 * them is how automation engines become privilege-escalation paths:
 *
 *  1. AUTHORING — may this CALLER create, edit, enable or manually run a
 *     workflow? Checked in `service.ts` against the caller's own context,
 *     `requirePermission()` first in every public method. Enabling and
 *     manual runs need `run_automation` ("automation admin", spec 25 §8);
 *     ordinary CRUD needs the matching create/update/delete.
 *
 *  2. EXECUTION — may this ACTION happen? Checked against the WORKFLOW
 *     OWNER's live workspace role (`WorkflowActorRoleResolver`), never the
 *     role of whoever happened to trigger the event, and never a role
 *     snapshotted when the workflow was saved. A workflow is therefore
 *     exactly as powerful as its owner is *right now*: demote the owner to
 *     viewer and their automation stops being able to write.
 *
 * Both layers use the shared foundation policy from `@yourcrm/permissions`.
 * There is no second role model here.
 */

export const WORKFLOW_OBJECT = "workflow"

export function workflowPermission(
  ctx: ServiceContext,
  action: PermissionAction,
  object: string = WORKFLOW_OBJECT,
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
 * What each action type needs, expressed in the shared permission
 * vocabulary. `object: "target"` means "the object the triggering record
 * belongs to" — updating a deal is a `deal:update`, not a generic write.
 *
 * EXTENSION POINT: a future `send_email` / `send_sms` / `send_whatsapp`
 * action maps to the `send_external` action that `@yourcrm/permissions`
 * already defines for exactly that purpose.
 */
export const WORKFLOW_ACTION_PERMISSIONS: Record<
  WorkflowActionType,
  { object: string | "target"; action: PermissionAction }
> = {
  create_task: { object: "task", action: "create" },
  update_field: { object: "target", action: "update" },
  add_tag: { object: "tag", action: "create" },
  notify: { object: "notification", action: "create" },
}

/**
 * Permission required to perform one action on one target. Kept separate
 * from the check itself so routes and the UI can explain a denial without
 * triggering one.
 */
export function workflowActionPermission(
  actorCtx: ServiceContext,
  actionType: WorkflowActionType,
  target: WorkflowActionTarget | null,
): PermissionContext {
  const rule = WORKFLOW_ACTION_PERMISSIONS[actionType]
  const object = rule.object === "target" ? (target?.entityType ?? WORKFLOW_OBJECT) : rule.object
  const base = workflowPermission(actorCtx, rule.action, object)
  return target === null ? base : { ...base, recordId: target.entityId }
}

/**
 * THE privilege-escalation gate. Throws the shared `PermissionDeniedError`
 * (so the run records a FORBIDDEN failure and the route maps it to 403)
 * when the workflow owner could not perform this action by hand.
 */
export function assertWorkflowActionAllowed(
  actorCtx: ServiceContext,
  actionType: WorkflowActionType,
  target: WorkflowActionTarget | null,
): void {
  requirePermission(workflowActionPermission(actorCtx, actionType, target))
}

/**
 * A run's actor must still be a member of the workspace. A workflow whose
 * owner was removed does not silently fall back to a default role — it
 * refuses to run.
 */
export function assertWorkflowActorResolved(
  workspaceId: string,
  actorId: string,
  role: string | null,
): asserts role is string {
  if (actorId === "") {
    throw new PermissionDeniedError(
      { workspaceId, actorId, object: WORKFLOW_OBJECT, action: "run_automation" },
      "this workflow has no owner to run as",
    )
  }
  if (role === null) {
    throw new PermissionDeniedError(
      { workspaceId, actorId, object: WORKFLOW_OBJECT, action: "run_automation" },
      "the workflow owner is no longer a member of this workspace",
    )
  }
}
