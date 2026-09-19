import { createEvent, getEventBus, NotificationEvents } from "@yourcrm/events"
import { requirePermission } from "@yourcrm/permissions"
import { isWithinQuietHours, resolveChannels, toEffectivePreference } from "./preferences"
import {
  createAppNotificationSchema,
  notificationListQuerySchema,
  updateNotificationPreferencesSchema,
} from "./schemas"
import type {
  AppNotification,
  NotificationListResult,
  NotificationPreferenceRecord,
  NotificationsServiceContext,
  NotificationsServiceDeps,
} from "./types"

export class AppNotificationNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`notification ${id} not found`)
    this.name = "AppNotificationNotFoundError"
  }
}

function permissionOf(
  ctx: NotificationsServiceContext,
  action: "read" | "create" | "update" | "delete",
  object: "notification" | "notification_preference" = "notification",
) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object,
    action,
  }
}

/**
 * Notifications domain service (spec 43-notifications, P0).
 *
 * Every method:
 *  1. calls `requirePermission()` FIRST, before any read or write;
 *  2. scopes every store call to (workspaceId, ctx.actorId) — a caller can
 *     never read/mutate another user's notifications by passing a
 *     different id (see the `people` reference module for the pattern);
 *  3. emits the domain event via `NotificationEvents` (never a literal);
 *  4. writes the audit row (mutations only).
 *
 * `create()` is the enforcement point spec 43 calls out explicitly:
 * preference/quiet-hours suppression happens HERE, server-side, at send
 * time — a suppressed notification is never written to the store. It
 * returns `null` (not an error) when suppressed, so callers such as the
 * automation `notify` action or a future mentions/assignment producer can
 * treat "suppressed" as a normal, silent outcome.
 */
export function createNotificationsService(deps: NotificationsServiceDeps) {
  const events = deps.events ?? getEventBus()
  const now = deps.now ?? (() => new Date())

  async function list(
    ctx: NotificationsServiceContext,
    rawQuery: unknown,
  ): Promise<NotificationListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = notificationListQuerySchema.parse(rawQuery)
    return deps.store.list(ctx.workspaceId, ctx.actorId, query)
  }

  async function unreadCount(ctx: NotificationsServiceContext): Promise<number> {
    requirePermission(permissionOf(ctx, "read"))
    return deps.store.countUnread(ctx.workspaceId, ctx.actorId)
  }

  async function get(ctx: NotificationsServiceContext, id: string): Promise<AppNotification> {
    requirePermission(permissionOf(ctx, "read"))
    const found = await deps.store.findById(ctx.workspaceId, ctx.actorId, id)
    if (!found) throw new AppNotificationNotFoundError(id)
    return found
  }

  /**
   * Create an in-app notification, enforcing preferences + quiet hours
   * first. Returns `null` when the category/channel is disabled or the
   * recipient is inside their quiet-hours window — in both cases nothing
   * is written to `notifications` and no event/audit fires, by design
   * (there is nothing to audit: the notification never existed).
   */
  async function create(
    ctx: NotificationsServiceContext,
    rawInput: unknown,
  ): Promise<AppNotification | null> {
    requirePermission(permissionOf(ctx, "create"))
    const input = createAppNotificationSchema.parse(rawInput)
    const prefRow = await deps.preferencesStore.get(ctx.workspaceId, input.userId)
    const effective = toEffectivePreference(prefRow)

    if (!resolveChannels(effective, input.type).in_app) {
      return null
    }
    if (isWithinQuietHours(effective, now().toISOString())) {
      return null
    }

    const notification = await deps.store.create(ctx.workspaceId, input, ctx.actorId)
    await events.emit(
      createEvent({
        event: NotificationEvents.Created,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "notification",
        entityId: notification.id,
        after: notification,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "notification",
      recordId: notification.id,
      after: notification,
      correlationId: ctx.correlationId,
    })
    return notification
  }

  async function markRead(ctx: NotificationsServiceContext, id: string): Promise<AppNotification> {
    requirePermission(permissionOf(ctx, "update"))
    const updated = await deps.store.markRead(ctx.workspaceId, ctx.actorId, id)
    if (!updated) throw new AppNotificationNotFoundError(id)
    await events.emit(
      createEvent({
        event: NotificationEvents.Read,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "notification",
        entityId: id,
        after: updated,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "read",
      object: "notification",
      recordId: id,
      after: updated,
      correlationId: ctx.correlationId,
    })
    return updated
  }

  async function markAllRead(ctx: NotificationsServiceContext): Promise<{ updated: number }> {
    requirePermission(permissionOf(ctx, "update"))
    const result = await deps.store.markAllRead(ctx.workspaceId, ctx.actorId)
    await events.emit(
      createEvent({
        event: NotificationEvents.AllRead,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "notification",
        after: result,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "read_all",
      object: "notification",
      after: result,
      correlationId: ctx.correlationId,
    })
    return result
  }

  async function softDelete(
    ctx: NotificationsServiceContext,
    id: string,
  ): Promise<AppNotification> {
    requirePermission(permissionOf(ctx, "delete"))
    const before = await deps.store.findById(ctx.workspaceId, ctx.actorId, id)
    if (!before) throw new AppNotificationNotFoundError(id)
    await deps.store.softDelete(ctx.workspaceId, ctx.actorId, id, ctx.actorId)
    await events.emit(
      createEvent({
        event: NotificationEvents.Deleted,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "notification",
        entityId: id,
        before,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "notification",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function getPreferences(
    ctx: NotificationsServiceContext,
  ): Promise<NotificationPreferenceRecord | null> {
    requirePermission(permissionOf(ctx, "read", "notification_preference"))
    return deps.preferencesStore.get(ctx.workspaceId, ctx.actorId)
  }

  async function updatePreferences(
    ctx: NotificationsServiceContext,
    rawPatch: unknown,
  ): Promise<NotificationPreferenceRecord> {
    requirePermission(permissionOf(ctx, "update", "notification_preference"))
    const patch = updateNotificationPreferencesSchema.parse(rawPatch)
    const before = await deps.preferencesStore.get(ctx.workspaceId, ctx.actorId)
    const after = await deps.preferencesStore.upsert(
      ctx.workspaceId,
      ctx.actorId,
      patch,
      ctx.actorId,
    )
    await events.emit(
      createEvent({
        event: NotificationEvents.PreferencesUpdated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "notification_preference",
        entityId: after.id,
        before,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "notification_preference",
      recordId: after.id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  return {
    list,
    unreadCount,
    get,
    create,
    markRead,
    markAllRead,
    softDelete,
    getPreferences,
    updatePreferences,
  }
}

export type NotificationsService = ReturnType<typeof createNotificationsService>
