import {
  PermissionDeniedError,
  requirePermission,
  type PermissionAction,
  type PermissionContext,
} from "@yourcrm/permissions"
import type { ServiceContext } from "../index"
import type { SalesSequenceStepTypeValue } from "./schemas"

/**
 * Sales sequence access policy.
 *
 * Two distinct questions, answered in two different places — confusing
 * them is how outreach engines become privilege-escalation paths, and the
 * automation engine's `access.ts` makes exactly the same split:
 *
 *  1. AUTHORING — may this CALLER create, edit, activate a sequence or
 *     enrol somebody into it? Checked in `service.ts` against the caller's
 *     own context, `requirePermission()` first in every public method.
 *
 *  2. EXECUTION — may this STEP happen? Checked against the SEQUENCE
 *     OWNER's live workspace role (`SalesSequenceActorRoleResolver`),
 *     never the role of whoever enrolled the person, and never a role
 *     snapshotted when the sequence was written. A sequence is therefore
 *     exactly as powerful as its owner is *right now*: demote the owner to
 *     viewer and their sequence stops being able to send.
 *
 * WHY ACTIVATION NEEDS `send_external`, NOT `run_automation`
 * ----------------------------------------------------------
 * Turning a workflow on needs `run_automation` (spec 25 §8, admin-rank)
 * because a workflow writes to arbitrary records. A sequence does one
 * thing: it emails prospects on the owner's behalf. The honest gate is
 * therefore the one `@yourcrm/permissions` already defines for putting a
 * message on the wire — `send_external`, which a `member` has and a
 * `viewer` does not. Requiring admin instead would lock the module away
 * from the sales reps it exists for, and would not make it safer: every
 * individual send is still checked against the owner's live role.
 *
 * Pausing only needs `update`: stopping a running sequence must never be
 * harder than starting it.
 *
 * Both layers use the shared foundation policy from `@yourcrm/permissions`.
 * There is no second role model here.
 */

export const SALES_SEQUENCE_OBJECT = "sequence"
export const SALES_SEQUENCE_ENROLLMENT_OBJECT = "sequence_enrollment"

export function salesSequencePermission(
  ctx: ServiceContext,
  action: PermissionAction,
  object: string = SALES_SEQUENCE_OBJECT,
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
 * What each step type needs, in the shared permission vocabulary.
 *
 * `email` maps to `send_external` — the action `@yourcrm/permissions`
 * defines for exactly this — checked against the OWNER. A viewer-owned
 * sequence therefore cannot send, no matter who enrolled the person or
 * who activated it.
 *
 * `wait` still requires `read`: an actor who has lost all access to the
 * workspace must not keep a drip alive, even a silent one.
 */
export const SALES_SEQUENCE_STEP_PERMISSIONS: Record<
  SalesSequenceStepTypeValue,
  { object: string; action: PermissionAction }
> = {
  email: { object: "email_message", action: "send_external" },
  task: { object: "task", action: "create" },
  wait: { object: SALES_SEQUENCE_OBJECT, action: "read" },
}

/**
 * Permission required to execute one step type. Kept separate from the
 * check itself so routes and the UI can explain a denial without
 * triggering one.
 */
export function salesSequenceStepPermission(
  actorCtx: ServiceContext,
  stepType: SalesSequenceStepTypeValue,
): PermissionContext {
  const rule = SALES_SEQUENCE_STEP_PERMISSIONS[stepType]
  return salesSequencePermission(actorCtx, rule.action, rule.object)
}

/**
 * THE privilege-escalation gate. Throws the shared `PermissionDeniedError`
 * (so the step records a FORBIDDEN failure and the route maps it to 403)
 * when the sequence owner could not perform this step by hand.
 */
export function assertSalesSequenceStepAllowed(
  actorCtx: ServiceContext,
  stepType: SalesSequenceStepTypeValue,
): void {
  requirePermission(salesSequenceStepPermission(actorCtx, stepType))
}

/**
 * A step's actor must still be a member of the workspace. A sequence whose
 * owner was removed does not silently fall back to a default role — it
 * refuses to run.
 */
export function assertSalesSequenceActorResolved(
  workspaceId: string,
  actorId: string,
  role: string | null,
): asserts role is string {
  if (actorId === "") {
    throw new PermissionDeniedError(
      { workspaceId, actorId, object: SALES_SEQUENCE_OBJECT, action: "send_external" },
      "this sequence has no owner to send as",
    )
  }
  if (role === null) {
    throw new PermissionDeniedError(
      { workspaceId, actorId, object: SALES_SEQUENCE_OBJECT, action: "send_external" },
      "the sequence owner is no longer a member of this workspace",
    )
  }
}
