import {
  checkPermission,
  type PermissionAction,
  type PermissionContext,
} from "@yourcrm/permissions"
import {
  CONVERSATION_SUBJECT_TYPE_NAMES,
  type ConversationIntelligenceServiceContext,
  type ConversationSourceRegistry,
  type ConversationSubjectType,
} from "./types"

/**
 * Conversation-intelligence access policy (spec 37 §8, P0).
 *
 * Pure functions, so the rules are unit-testable without a store, a route
 * or a provider. Layered ON TOP of the shared foundation policy in
 * `@yourcrm/permissions` — never instead of it, and never a second role
 * model. Structured exactly like `../unified-inbox/visibility.ts`, which
 * answers the same question for the same three channels.
 *
 * ## An analysis is not a record of its own
 *
 * This is the rule the whole module is built around:
 *
 *   **An analysis is readable exactly when its subject is readable.**
 *
 * A summary of an email thread is a lossy copy of that thread. If reading
 * the summary needed a weaker check than reading the thread, the summary
 * would be a permission bypass with an AI label on it. So there are two
 * gates and both must pass:
 *
 *  1. **Object gate** (here). `read` on `conversation_analysis`, plus
 *     `read` on the SUBJECT'S own permission object — the same object the
 *     owning module checks (`email_thread`, `whatsapp_conversation`,
 *     `call`). A caller who cannot read calls cannot read call analyses,
 *     and the type never even appears in their list query.
 *  2. **Record gate** (`ConversationSourcePort.load`, see `types.ts`).
 *     The owning module's domain service resolves the actual
 *     conversation under the caller's context and applies its own
 *     record-level visibility. Missing and hidden are indistinguishable.
 *
 * Nothing about the subject's visibility is copied into this module's
 * tables, so nothing can go stale when a thread is reassigned.
 *
 * ## Why analysing is gated on `read`, not `run_ai`
 *
 * Deliberate, and consistent with `../ai-assistant/access.ts`. An analysis
 * derives nothing the caller could not already read for themselves — it
 * restates a conversation they have open in front of them. Gating it at
 * `run_ai` (member rank) would lock viewers out of a summary of their own
 * thread while leaving them the thread itself, which protects nothing.
 *
 * `run_ai` remains the gate for the AI actions that CHANGE something:
 * `proposeConversationActionItem` goes through the spec 38 approval
 * queue, whose `requestAction` requires `run_ai`. That is the seam where
 * the privilege level rises, and it rises because the operation writes,
 * not because it is AI.
 */

export const CONVERSATION_ANALYSIS_OBJECT = "conversation_analysis"

export const CALL_TRANSCRIPT_OBJECT = "call_transcript"

/**
 * The object each subject type's read permission is checked against.
 * These are the owning modules' own object names, so an analysis reader
 * can never see more than they could in Email, WhatsApp or Calling.
 */
export const CONVERSATION_SUBJECT_PERMISSION_OBJECTS: Record<ConversationSubjectType, string> = {
  email_thread: "email_thread",
  whatsapp_conversation: "whatsapp_conversation",
  call: "call",
}

export function conversationPermission(
  ctx: ConversationIntelligenceServiceContext,
  action: PermissionAction,
  object: string = CONVERSATION_ANALYSIS_OBJECT,
): PermissionContext {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object,
    action,
  }
}

/** Permission context for the subject a request names. */
export function conversationSubjectPermission(
  ctx: ConversationIntelligenceServiceContext,
  subjectType: ConversationSubjectType,
  action: PermissionAction = "read",
): PermissionContext {
  return conversationPermission(ctx, action, CONVERSATION_SUBJECT_PERMISSION_OBJECTS[subjectType])
}

/**
 * Subject types the caller may read AND this deployment can resolve, in a
 * stable order. An empty result is a real answer: the service turns it
 * into an empty page, never "all subject types".
 *
 * A subject type with no registered source is excluded even for an owner —
 * an analysis whose conversation cannot be re-resolved cannot have its
 * visibility re-checked, so it is withheld rather than trusted.
 */
export function readableConversationSubjectTypes(
  ctx: ConversationIntelligenceServiceContext,
  sources: ConversationSourceRegistry,
  requested?: ConversationSubjectType | null,
): ConversationSubjectType[] {
  const available = new Set(sources.subjectTypes())
  const candidates =
    requested === undefined || requested === null ? CONVERSATION_SUBJECT_TYPE_NAMES : [requested]
  return candidates.filter(
    (subjectType) =>
      available.has(subjectType) &&
      checkPermission(conversationSubjectPermission(ctx, subjectType)).allowed,
  )
}

/** True when the caller passes the object gate for this subject type. */
export function canReadConversationSubjectType(
  ctx: ConversationIntelligenceServiceContext,
  subjectType: ConversationSubjectType,
): boolean {
  return checkPermission(conversationSubjectPermission(ctx, subjectType)).allowed
}
