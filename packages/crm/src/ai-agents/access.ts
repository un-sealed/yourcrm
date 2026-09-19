import {
  PermissionDeniedError,
  requirePermission,
  type PermissionAction,
  type PermissionContext,
} from "@yourcrm/permissions"
import type { AiAgentServiceContext, AiAgentToolContext } from "./types"

/**
 * AI agent access policy.
 *
 * THREE distinct questions, answered in three places. Confusing them is
 * how an agent framework becomes a privilege-escalation path:
 *
 *  1. AUTHORING — may this CALLER create, edit or delete a definition?
 *     Checked in `service.ts` against the caller's own context,
 *     `requirePermission()` first in every public method. Turning an agent
 *     ON, and pressing Run, additionally need `run_ai`: those are the acts
 *     that make a model act on this workspace's behalf.
 *
 *  2. EXECUTION — may this run happen at all? Checked against the AGENT
 *     OWNER's LIVE workspace role (`AiAgentActorRoleResolver`), never the
 *     role of whoever emitted the triggering event and never a role
 *     snapshotted when the agent was saved. An agent is therefore exactly
 *     as powerful as its owner is *right now*.
 *
 *  3. EACH TOOL — may this owner do this, by hand, today?
 *     `requirePermission()` runs inside every tool (`../ai-assistant`'s
 *     read tools do it themselves; the proposal tool's check happens in
 *     `../ai-governance`'s `requestAction`, which re-resolves the live
 *     role a second time and checks the TARGET action).
 *
 * ## Why execution is gated on `read`, not `run_ai`
 *
 * The same reason the read-only assistant is (`../ai-assistant/access.ts`):
 * `run_ai` sits at member rank, and an agent's READS are strictly a subset
 * of what its owner could already query by hand, executed with that
 * owner's row scope. Gating execution on `run_ai` would not make a single
 * read safer — it would only mean that demoting an owner to viewer
 * silently *stops* their agent instead of *narrowing* it.
 *
 * Narrowing is the better property and it is the tested one: a
 * viewer-owned agent still runs, sees exactly what a viewer sees, and is
 * refused the moment it proposes a write — because `requestAction` demands
 * `run_ai` plus the target action, and a viewer has neither. The gate that
 * matters is on the WRITE, and it lives in the approval queue where one
 * implementation serves every AI feature.
 */

export const AI_AGENT_OBJECT = "ai_agent"

export const AI_AGENT_RUN_OBJECT = "ai_agent_run"

export const AI_AGENT_TOOL_OBJECT = "ai_agent_tool"

export function aiAgentPermission(
  ctx: AiAgentServiceContext | AiAgentToolContext,
  action: PermissionAction,
  object: string = AI_AGENT_OBJECT,
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
 * A run's actor must still be a member of the workspace. An agent whose
 * owner was removed does not fall back to a default role — it refuses to
 * run, and the run records why.
 */
export function assertAiAgentActorResolved(
  workspaceId: string,
  actorId: string,
  role: string | null,
): asserts role is string {
  if (actorId === "") {
    throw new PermissionDeniedError(
      { workspaceId, actorId, object: AI_AGENT_OBJECT, action: "run_ai" },
      "this agent has no owner to run as",
    )
  }
  if (role === null) {
    throw new PermissionDeniedError(
      { workspaceId, actorId, object: AI_AGENT_OBJECT, action: "run_ai" },
      "the agent owner is no longer a member of this workspace",
    )
  }
}

/**
 * The execution gate: the owner, with their live role, must at least be
 * able to read this workspace's agents. See the header for why this is
 * `read` and not `run_ai`.
 */
export function assertAiAgentRunAllowed(actor: {
  workspaceId: string
  actorId: string
  role: string
}): void {
  requirePermission({
    workspaceId: actor.workspaceId,
    actorId: actor.actorId,
    role: actor.role,
    object: AI_AGENT_OBJECT,
    action: "read",
  })
}

/**
 * An agent runs as its owner, so letting an author hand ownership to a
 * more privileged colleague would be an escalation dressed as a form
 * field. Ownership is the author unless an admin says otherwise — the same
 * rule `../automation` applies to workflows.
 */
export function assertMayAssignAiAgentOwner(ctx: AiAgentServiceContext, ownerId: string): string {
  requirePermission(aiAgentPermission(ctx, "admin"))
  return ownerId
}
