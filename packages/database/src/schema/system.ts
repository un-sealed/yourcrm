import { isNull } from "drizzle-orm"
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { baseColumns, workspaceColumn } from "./base"

/**
 * Append-only audit log. Every important mutation records workspace, actor,
 * action, object, record id, before/after, correlation id and source
 * (user | automation | ai | integration | mcp).
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    ...baseColumns,
    ...workspaceColumn,
    actorId: uuid("actor_id"),
    action: varchar("action", { length: 64 }).notNull(),
    object: varchar("object", { length: 64 }).notNull(),
    recordId: uuid("record_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    correlationId: varchar("correlation_id", { length: 64 }),
    source: varchar("source", { length: 32 }).notNull().default("user"),
  },
  (t) => [
    index("audit_events_workspace_idx").on(t.workspaceId),
    index("audit_events_object_record_idx").on(t.object, t.recordId),
    index("audit_events_created_idx").on(t.createdAt),
  ],
)

export type AuditEvent = typeof auditEvents.$inferSelect
export type NewAuditEvent = typeof auditEvents.$inferInsert

export const notifications = pgTable(
  "notifications",
  {
    ...baseColumns,
    ...workspaceColumn,
    userId: uuid("user_id").notNull(),
    type: varchar("type", { length: 64 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    body: text("body"),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [
    index("notifications_user_idx").on(t.userId),
    // Notifications module (spec 43, migration 0370): every list query is
    // scoped to (workspaceId, userId) — a user only ever reads their own
    // notifications — and orders unread-first, so this composite index
    // covers both the ownership filter and the sort in one pass.
    index("notifications_workspace_user_unread_idx").on(
      t.workspaceId,
      t.userId,
      t.readAt,
      t.createdAt,
    ),
  ],
)

export type Notification = typeof notifications.$inferSelect
export type NewNotification = typeof notifications.$inferInsert

/**
 * Per-user notification preferences (spec 43-notifications, P0, migration
 * 0370). One row per (workspace, user) — `notification_preferences_user_uidx`
 * enforces it. `categories` is a JSONB map of category name ->
 * `{ in_app, email, push, sms }` channel toggles; a category absent from the
 * map falls back to the default (`in_app: true`, everything else `false`) —
 * see `packages/crm/src/notifications/preferences.ts` `resolveChannels()`.
 *
 * Quiet hours are wall-clock `"HH:MM"` strings evaluated in `timezone`
 * (IANA name, read-side conversion only — see
 * `packages/crm/src/calendar/timezone.ts`, reused rather than duplicated).
 *
 * Email/push/SMS are modelled here but not delivered in P0 — see
 * `NotificationDeliveryPort` in `packages/crm/src/notifications/types.ts`.
 */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    ...baseColumns,
    ...workspaceColumn,
    userId: uuid("user_id").notNull(),
    categories: jsonb("categories").notNull().default({}),
    quietHoursEnabled: boolean("quiet_hours_enabled").notNull().default(false),
    quietHoursStart: varchar("quiet_hours_start", { length: 5 }),
    quietHoursEnd: varchar("quiet_hours_end", { length: 5 }),
    timezone: varchar("timezone", { length: 64 }).notNull().default("UTC"),
  },
  (t) => [
    index("notification_preferences_workspace_idx").on(t.workspaceId),
    uniqueIndex("notification_preferences_user_uidx")
      .on(t.workspaceId, t.userId)
      .where(isNull(t.deletedAt)),
  ],
)

export type NotificationPreference = typeof notificationPreferences.$inferSelect
export type NewNotificationPreference = typeof notificationPreferences.$inferInsert
