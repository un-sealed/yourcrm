import {
  PermissionDeniedError,
  type PermissionAction,
  type PermissionContext,
} from "@yourcrm/permissions"
import type { AiAssistantServiceContext, AiConversationRecord, AiConversationScope } from "./types"

/**
 * Assistant access policy.
 *
 * Layers record-level rules ON TOP of the shared foundation policy in
 * `@yourcrm/permissions` — it never replaces it and never invents a second
 * role model. Mirrors `../reports/access.ts`, which solves the same problem
 * for report execution.
 *
 * ## Why asking is a `read`, not a `run_ai`
 *
 * `run_ai` sits at member rank in the foundation policy, so gating the
 * question box behind it would lock viewers out of *their own* data. In P0
 * the assistant is strictly read-only: every tool it can call is a wrapper
 * over a query the caller could already run by hand in the reports module,
 * executed with that caller's permissions and row scope. So the entry gate
 * is `read` on `ai_conversation` — no privilege the asker did not already
 * have is ever exercised.
 *
 * `run_ai` is reserved for the write-capable agents of spec
 * 38-ai-governance: the moment a tool can change data or send something
 * externally, the action gate moves up to `run_ai` plus that spec's
 * approval queue. That is a deliberate seam, not an omission.
 *
 * ## Conversations are personal
 *
 * A chat log is the user's own record: `assertAiConversationVisible` allows
 * the owner and nobody else — not even a workspace admin. Administrative
 * oversight of AI usage is spec 38's job and reads the audit trail (every
 * run and every tool call writes one), not other people's chat history.
 */

export const AI_CONVERSATION_OBJECT = "ai_conversation"

export const AI_RUN_OBJECT = "ai_run"

export const AI_TOOL_CALL_OBJECT = "ai_tool_call"

export function aiPermission(
  ctx: AiAssistantServiceContext,
  action: PermissionAction,
  object: string = AI_CONVERSATION_OBJECT,
): PermissionContext {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object,
    action,
  }
}

/** Conversations a caller may list. Always their own — see the header. */
export function resolveAiConversationScope(ctx: AiAssistantServiceContext): AiConversationScope {
  return { kind: "own", actorId: ctx.actorId }
}

/** The user a stored conversation belongs to. */
export function aiConversationOwnerId(conversation: AiConversationRecord): string | null {
  const userId = conversation.userId
  if (typeof userId === "string" && userId !== "") return userId
  const createdBy = conversation.createdBy
  return typeof createdBy === "string" && createdBy !== "" ? createdBy : null
}

/**
 * Record-level gate for one conversation. Throws the shared
 * `PermissionDeniedError` (so `expectDenied` and the route's 403 mapping
 * both recognise it) when the conversation belongs to somebody else.
 */
export function assertAiConversationVisible(
  ctx: AiAssistantServiceContext,
  conversation: AiConversationRecord,
  action: PermissionAction,
): void {
  if (aiConversationOwnerId(conversation) === ctx.actorId) return
  throw new PermissionDeniedError(
    { ...aiPermission(ctx, action), recordId: conversation.id },
    "this conversation belongs to another user",
  )
}
