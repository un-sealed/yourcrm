import { checkPermission } from "@yourcrm/permissions"
import { INBOX_CHANNEL_NAMES } from "./types"
import type { InboxChannelName, InboxVisibility, UnifiedInboxServiceContext } from "./types"

/**
 * Permission resolution for the unified inbox — pure functions, so the rules
 * are unit-testable without a store, a route or a database.
 *
 * The inbox aggregates three modules, so "can this actor read this item?" has
 * two independent halves and BOTH are answered here, before any SQL runs:
 *
 *  1. **Channel access** (spec 15 §8). A channel contributes to the stream
 *     only if the caller may read that channel's own object. The object names
 *     are the ones the source modules already use, so an inbox reader can
 *     never see more than they could in Email, WhatsApp or Calling directly.
 *  2. **Record visibility.** Within a readable channel, who may see which
 *     conversation. Resolved to an `InboxVisibility` the store turns into a
 *     WHERE predicate — never a post-pagination filter, which would return
 *     short pages and leak the existence of hidden conversations.
 */

/** The object each channel's read permission is checked against. */
export const INBOX_CHANNEL_PERMISSION_OBJECTS: Record<InboxChannelName, string> = {
  email: "email_thread",
  whatsapp: "whatsapp_conversation",
  call: "call",
}

/** Permission object for the inbox itself (assignment, read state, archive). */
export const INBOX_PERMISSION_OBJECT = "inbox_conversation"

/**
 * Channels the caller may read, in stream order. An empty result is a real
 * answer — the service turns it into an empty page, never "all channels".
 */
export function readableInboxChannels(
  ctx: UnifiedInboxServiceContext,
  requested?: InboxChannelName | null,
): InboxChannelName[] {
  const candidates =
    requested === undefined || requested === null ? INBOX_CHANNEL_NAMES : [requested]
  return candidates.filter(
    (channel) =>
      checkPermission({
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        role: ctx.role ?? "viewer",
        object: INBOX_CHANNEL_PERMISSION_OBJECTS[channel],
        action: "read",
      }).allowed,
  )
}

/**
 * Record-level visibility.
 *
 * Workspace administrators (anyone who passes the `admin` action) see every
 * conversation. Everybody else sees the conversations they are connected to —
 * owned, created, or assigned to them — plus the shared queue of conversations
 * that are neither owned nor assigned, which is what makes a team inbox useful
 * rather than a private one.
 *
 * The consequence is deliberate and tested: a member sees strictly fewer items
 * than an admin in the same workspace.
 */
export function inboxVisibilityScope(ctx: UnifiedInboxServiceContext): InboxVisibility {
  const isAdmin = checkPermission({
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: INBOX_PERMISSION_OBJECT,
    action: "admin",
  }).allowed
  return isAdmin ? { kind: "all" } : { kind: "own", actorId: ctx.actorId }
}
