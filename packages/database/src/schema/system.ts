import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core"
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
  (t) => [index("notifications_user_idx").on(t.userId)],
)

export type Notification = typeof notifications.$inferSelect
