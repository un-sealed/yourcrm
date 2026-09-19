import {
  PermissionDeniedError,
  requirePermission,
  type PermissionAction,
  type PermissionContext,
} from "@yourcrm/permissions"
import type { AiActionType } from "./schemas"
import type { AiGovernanceServiceContext } from "./types"

/**
 * AI governance access policy — the file the product principle "humans
 * remain in control of AI" actually lives in.
 *
 * Three distinct questions, answered in three places, and confusing them
 * is how an approval queue becomes a privilege-escalation path:
 *
 *  1. QUEUE ACCESS — may this caller see and act on the queue at all?
 *     `requirePermission()` first in every service method, against the
 *     caller's own context and the `ai_action_request` object. Reading is
 *     `read`; managing policies is `admin` (spec 38 §8: security/admin).
 *
 *  2. PROPOSING — may this actor ask for this change? Checked against the
 *     requesting actor with the `run_ai` permission plus the TARGET
 *     action's own permission, so an AI cannot even queue something its
 *     principal could not do by hand.
 *
 *  3. EXECUTION — may this approved action happen? Checked against BOTH
 *     the requesting actor's and the approver's LIVE workspace roles. See
 *     `assertAiActionAllowed`.
 *
 * All three use the shared foundation policy from `@yourcrm/permissions`.
 * There is no second role model here, and no AI-specific permission: an AI
 * action is an ordinary `person:update` that happens to have a model
 * attached. This mirrors `automation/access.ts` on purpose — the product
 * has one answer to "how does a non-human actor inherit permissions", and
 * this is it.
 */

export const AI_ACTION_OBJECT = "ai_action_request"
export const AI_POLICY_OBJECT = "ai_policy"

export function aiGovernancePermission(
  ctx: AiGovernanceServiceContext,
  action: PermissionAction,
  object: string = AI_ACTION_OBJECT,
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
 * What each proposed action needs, in the shared permission vocabulary.
 * `send_external` is the action `@yourcrm/permissions` already defines for
 * "this leaves the building" — an AI-drafted email is governed by the same
 * permission as a hand-written one.
 */
export const AI_ACTION_PERMISSIONS: Record<AiActionType, PermissionAction> = {
  create: "create",
  update: "update",
  delete: "delete",
  send_external: "send_external",
}

/** The target of a governed action: an object type plus an optional record. */
export type AiActionTarget = {
  objectType: string
  recordId?: string | null
  action: AiActionType
}

/**
 * Permission one actor would need to perform this action BY HAND. Kept
 * separate from the check itself so routes and the UI can explain a
 * denial without triggering one.
 */
export function aiActionPermission(
  actor: { workspaceId: string; actorId: string; role: string },
  target: AiActionTarget,
): PermissionContext {
  const base: PermissionContext = {
    workspaceId: actor.workspaceId,
    actorId: actor.actorId,
    role: actor.role,
    object: target.objectType,
    action: AI_ACTION_PERMISSIONS[target.action],
  }
  return target.recordId == null || target.recordId === ""
    ? base
    : { ...base, recordId: target.recordId }
}

/**
 * THE PRIVILEGE-ESCALATION GATE.
 *
 * An approved AI action executes with the permissions of the requesting
 * actor AND the approver — whichever is narrower. That is implemented as
 * an INTERSECTION rather than a role comparison on purpose: every actor is
 * put through the shared `requirePermission()` for the same target action,
 * and the first denial wins. A viewer approving a `person:update` is
 * refused because a viewer cannot update a person; an owner approving a
 * viewer's proposal is refused for the same reason on the other side.
 *
 * Comparing roles by rank would mean restating the role ladder here — a
 * second permission model, which is exactly what `AGENTS.md` forbids. The
 * intersection needs no ladder: it asks the one policy, twice.
 */
export function assertAiActionAllowed(
  actors: readonly { workspaceId: string; actorId: string; role: string }[],
  target: AiActionTarget,
): void {
  for (const actor of actors) {
    requirePermission(aiActionPermission(actor, target))
  }
}

/**
 * An actor must still be a member of the workspace. A request whose
 * proposer has been removed — or whose approver has — does not fall back
 * to a default role: it refuses.
 */
export function assertAiActorResolved(
  workspaceId: string,
  actorId: string,
  role: string | null,
  what: "requester" | "approver",
): asserts role is string {
  if (actorId === "") {
    throw new PermissionDeniedError(
      { workspaceId, actorId, object: AI_ACTION_OBJECT, action: "run_ai" },
      `this AI action has no ${what} to inherit permissions from`,
    )
  }
  if (role === null) {
    throw new PermissionDeniedError(
      { workspaceId, actorId, object: AI_ACTION_OBJECT, action: "run_ai" },
      `the ${what} is no longer a member of this workspace`,
    )
  }
}

/** Raised when the actor who asked for a change tries to wave it through. */
export class AiSelfApprovalError extends Error {
  readonly code = "FORBIDDEN"
  constructor(message: string) {
    super(message)
    this.name = "AiSelfApprovalError"
  }
}

/**
 * SELF-APPROVAL IS REFUSED.
 *
 * Approval is only a control if somebody other than the proposer performs
 * it. A human who used an AI feature may not rubber-stamp their own
 * proposal, and an agent may not approve the proposal it created — which
 * would make the whole queue decorative.
 *
 * Rejection is deliberately NOT covered: withdrawing your own proposal is
 * always safe, and making it hard would push people to approve instead.
 */
export function assertNotSelfApproval(requestActorId: string, approverId: string): void {
  if (requestActorId === approverId) {
    throw new AiSelfApprovalError(
      "the actor that requested this action cannot approve it — ask a colleague to review",
    )
  }
}

/**
 * AN AI ACTOR CAN NEVER APPROVE ANYTHING.
 *
 * `actorType` defaults to `user`: the HTTP layer only ever produces human
 * contexts (a session is a person), so an `agent` context can only come
 * from in-process AI code calling the service directly. That call is
 * refused here, at the service boundary, rather than being prevented only
 * by the fact that no route exposes it.
 */
export function assertHumanApprover(ctx: AiGovernanceServiceContext): void {
  if ((ctx.actorType ?? "user") !== "user") {
    throw new AiSelfApprovalError("an AI actor cannot approve or revert AI actions")
  }
}
