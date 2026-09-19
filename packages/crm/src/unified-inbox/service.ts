import { requirePermission } from "@yourcrm/permissions"
import {
  assignInboxItemSchema,
  inboxItemQuerySchema,
  inboxItemRefSchema,
  type InboxItemRef,
} from "./schemas"
import { INBOX_PERMISSION_OBJECT, inboxVisibilityScope, readableInboxChannels } from "./visibility"
import type {
  InboxAssignmentFilter,
  InboxItemRecord,
  InboxListResult,
  InboxStatePatch,
  UnifiedInboxServiceContext,
  UnifiedInboxServiceDeps,
} from "./types"

export class InboxItemNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(channel: string, sourceId: string) {
    super(`inbox item ${channel}:${sourceId} not found`)
    this.name = "InboxItemNotFoundError"
  }
}

function permissionOf(
  ctx: UnifiedInboxServiceContext,
  action: "read" | "create" | "update" | "delete",
) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: INBOX_PERMISSION_OBJECT,
    action,
  }
}

/**
 * Unified inbox domain service (spec 15-unified-inbox, P0).
 *
 * THIS MODULE IS AN AGGREGATOR. Email, WhatsApp and Calling own their
 * conversations, their threading, their composers and their detail views. The
 * inbox adds exactly three things on top: one ordered cross-channel stream,
 * assignment, and read/archive state. It reads the three modules' data through
 * the store port and writes only its own overlay — nothing here mutates an
 * email thread, a WhatsApp conversation or a call.
 *
 * Every method:
 *  1. calls `requirePermission()` FIRST, before any read or write;
 *  2. resolves channel access + record visibility (`./visibility.ts`) and
 *     hands them to the store, which filters in SQL;
 *  3. writes an audit row with before/after (mutations only).
 *
 * BLOCKER — domain events. Spec 15 §9 asks for `conversation.assigned` and
 * `conversation.closed`. `@yourcrm/events` has no constant for either (only
 * `CommunicationEvents.MessageReceived` / `MessageSent`, which the WhatsApp
 * and Email services already emit for the underlying messages), and this
 * module may not add one. Rather than emit a string literal — which would
 * break the "event constants only" rule and quietly create an event name no
 * consumer can import — the inbox emits no events in P0 and records every
 * mutation in the audit log. Adding `ConversationEvents.Assigned`,
 * `.Unassigned`, `.Read` and `.Archived` to `packages/events/src/envelope.ts`
 * is the one-line unblock; `UnifiedInboxServiceDeps.events` is already wired.
 */
export function createUnifiedInboxService(deps: UnifiedInboxServiceDeps) {
  function assignmentFilterOf(
    ctx: UnifiedInboxServiceContext,
    query: { assigned: "anyone" | "me" | "unassigned"; assignedTo?: string },
  ): InboxAssignmentFilter {
    if (query.assignedTo !== undefined) return { kind: "user", userId: query.assignedTo }
    if (query.assigned === "me") return { kind: "user", userId: ctx.actorId }
    if (query.assigned === "unassigned") return { kind: "unassigned" }
    return { kind: "any" }
  }

  /**
   * One page of the merged stream. Channels the caller may not read are
   * dropped before the query, and record visibility travels with it — an
   * actor can never page past an item they are not allowed to see.
   */
  async function list(
    ctx: UnifiedInboxServiceContext,
    rawQuery: unknown,
  ): Promise<InboxListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = inboxItemQuerySchema.parse(rawQuery)
    return deps.store.list(ctx.workspaceId, {
      channels: readableInboxChannels(ctx, query.channel),
      scope: inboxVisibilityScope(ctx),
      limit: query.limit,
      cursor: query.cursor,
      order: query.order,
      unread: query.unread === undefined ? undefined : query.unread === "true",
      archived: query.archived === undefined ? undefined : query.archived === "true",
      assignment: assignmentFilterOf(ctx, query),
      personId: query.personId,
      companyId: query.companyId,
      dealId: query.dealId,
    })
  }

  /** Load one item, or throw. Used by the route and by every mutation below. */
  async function get(ctx: UnifiedInboxServiceContext, rawRef: unknown): Promise<InboxItemRecord> {
    requirePermission(permissionOf(ctx, "read"))
    const ref = inboxItemRefSchema.parse(rawRef)
    return load(ctx, ref)
  }

  async function load(
    ctx: UnifiedInboxServiceContext,
    ref: InboxItemRef,
  ): Promise<InboxItemRecord> {
    // A channel the caller may not read behaves exactly like a missing item.
    if (readableInboxChannels(ctx, ref.channel).length === 0) {
      throw new InboxItemNotFoundError(ref.channel, ref.sourceId)
    }
    const found = await deps.store.findItem(
      ctx.workspaceId,
      ref.channel,
      ref.sourceId,
      inboxVisibilityScope(ctx),
    )
    if (!found) throw new InboxItemNotFoundError(ref.channel, ref.sourceId)
    return found
  }

  /**
   * Shared mutation path: permission, load (which enforces visibility), write
   * the overlay patch, reload, audit. Returns the item as it now stands.
   */
  async function mutate(
    ctx: UnifiedInboxServiceContext,
    rawRef: unknown,
    action: string,
    patch: (before: InboxItemRecord) => InboxStatePatch,
  ): Promise<InboxItemRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const ref = inboxItemRefSchema.parse(rawRef)
    const before = await load(ctx, ref)
    await deps.store.setState(
      ctx.workspaceId,
      ref.channel,
      ref.sourceId,
      patch(before),
      ctx.actorId,
    )
    const after = await load(ctx, ref)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action,
      object: INBOX_PERMISSION_OBJECT,
      recordId: before.id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /** Assign the conversation to a user, or unassign it when `assigneeId` is null. */
  async function assign(
    ctx: UnifiedInboxServiceContext,
    rawRef: unknown,
    rawInput: unknown,
  ): Promise<InboxItemRecord> {
    const input = assignInboxItemSchema.parse(rawInput)
    if (input.assigneeId === null) return unassign(ctx, rawRef)
    return mutate(ctx, rawRef, "assign", () => ({
      assignedTo: input.assigneeId,
      assignedAt: new Date(),
      assignedBy: ctx.actorId,
    }))
  }

  /**
   * Assign the conversation to the caller. The canonical shared-inbox action
   * ("I'll take this"), and the only assignment the UI can offer until a
   * workspace-members endpoint exists to pick somebody else from — see the
   * gap note in `apps/web/app/app/inbox/types.ts`.
   */
  async function claim(ctx: UnifiedInboxServiceContext, rawRef: unknown): Promise<InboxItemRecord> {
    return mutate(ctx, rawRef, "assign", () => ({
      assignedTo: ctx.actorId,
      assignedAt: new Date(),
      assignedBy: ctx.actorId,
    }))
  }

  async function unassign(
    ctx: UnifiedInboxServiceContext,
    rawRef: unknown,
  ): Promise<InboxItemRecord> {
    return mutate(ctx, rawRef, "unassign", () => ({
      assignedTo: null,
      assignedAt: null,
      assignedBy: ctx.actorId,
    }))
  }

  /**
   * Mark read. The watermark is stamped from the item's own last activity,
   * not from `now()`: stamping `now()` would also mark a message that arrives
   * in the same second as already read.
   */
  async function markRead(
    ctx: UnifiedInboxServiceContext,
    rawRef: unknown,
  ): Promise<InboxItemRecord> {
    return mutate(ctx, rawRef, "mark_read", (before) => ({ readAt: readWatermark(before) }))
  }

  async function markUnread(
    ctx: UnifiedInboxServiceContext,
    rawRef: unknown,
  ): Promise<InboxItemRecord> {
    return mutate(ctx, rawRef, "mark_unread", () => ({ readAt: null }))
  }

  async function archive(
    ctx: UnifiedInboxServiceContext,
    rawRef: unknown,
  ): Promise<InboxItemRecord> {
    return mutate(ctx, rawRef, "archive", () => ({ archivedAt: new Date() }))
  }

  async function unarchive(
    ctx: UnifiedInboxServiceContext,
    rawRef: unknown,
  ): Promise<InboxItemRecord> {
    return mutate(ctx, rawRef, "unarchive", () => ({ archivedAt: null }))
  }

  return { list, get, assign, claim, unassign, markRead, markUnread, archive, unarchive }
}

/**
 * The read watermark for "mark read": the item's last activity, or now when
 * the store did not report one. Exported for the API-layer adapter's tests.
 */
export function readWatermark(item: InboxItemRecord, now: Date = new Date()): Date {
  const sortAt = item.sortAt
  if (sortAt instanceof Date) return sortAt
  if (typeof sortAt === "string") {
    const parsed = new Date(sortAt)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return now
}

export type UnifiedInboxService = ReturnType<typeof createUnifiedInboxService>
