import { sql } from "drizzle-orm"
import { boolean, check, index, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core"
import { baseColumns, workspaceColumn } from "./base"

/**
 * Support / Ticketing module tables (spec 21-support, P0).
 * Migration `0250_support.sql`.
 *
 * `requester_id` (people.id), `assignee_id` (users.id) and
 * `ticket_comments.author_id` (users.id) are PLAIN uuid columns with
 * indexes and NO foreign keys — people and users are owned by other
 * modules/the auth foundation (same rule as people.company_id and
 * quotes.person_id). See the migration header for the full rationale,
 * the status-lifecycle note and the SLA/breach-job extension point.
 */

export const SUPPORT_TICKET_STATUSES = ["new", "open", "pending", "resolved", "closed"] as const

export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number]

export function isSupportTicketStatus(value: unknown): value is SupportTicketStatus {
  return typeof value === "string" && (SUPPORT_TICKET_STATUSES as readonly string[]).includes(value)
}

export const SUPPORT_TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const

export type SupportTicketPriority = (typeof SUPPORT_TICKET_PRIORITIES)[number]

export function isSupportTicketPriority(value: unknown): value is SupportTicketPriority {
  return (
    typeof value === "string" && (SUPPORT_TICKET_PRIORITIES as readonly string[]).includes(value)
  )
}

export const SUPPORT_TICKET_CHANNELS = [
  "email",
  "chat",
  "whatsapp",
  "phone",
  "web",
  "api",
  "manual",
] as const

export type SupportTicketChannel = (typeof SUPPORT_TICKET_CHANNELS)[number]

export function isSupportTicketChannel(value: unknown): value is SupportTicketChannel {
  return typeof value === "string" && (SUPPORT_TICKET_CHANNELS as readonly string[]).includes(value)
}

export const tickets = pgTable(
  "tickets",
  {
    ...baseColumns,
    ...workspaceColumn,
    subject: varchar("subject", { length: 255 }).notNull(),
    description: text("description"),
    status: varchar("status", { length: 16 }).notNull().default("new"),
    priority: varchar("priority", { length: 16 }).notNull().default("normal"),
    // Cross-module reference (plain uuid, NO foreign key — see header). people.id.
    requesterId: uuid("requester_id").notNull(),
    // Cross-module reference (plain uuid, NO foreign key — see header). users.id.
    assigneeId: uuid("assignee_id"),
    channel: varchar("channel", { length: 16 }).notNull().default("manual"),
    firstResponseDueAt: timestamp("first_response_due_at", { withTimezone: true }),
    firstResponseAt: timestamp("first_response_at", { withTimezone: true }),
    resolutionDueAt: timestamp("resolution_due_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    index("tickets_workspace_idx").on(t.workspaceId),
    index("tickets_status_idx").on(t.workspaceId, t.status),
    index("tickets_priority_idx").on(t.workspaceId, t.priority),
    index("tickets_requester_idx").on(t.requesterId),
    index("tickets_assignee_idx").on(t.workspaceId, t.assigneeId),
    index("tickets_first_response_due_idx")
      .on(t.workspaceId, t.firstResponseDueAt)
      .where(sql`${t.firstResponseAt} IS NULL`),
    index("tickets_resolution_due_idx")
      .on(t.workspaceId, t.resolutionDueAt)
      .where(sql`${t.resolvedAt} IS NULL`),
    check(
      "tickets_status_chk",
      sql`${t.status} IN ('new', 'open', 'pending', 'resolved', 'closed')`,
    ),
    check("tickets_priority_chk", sql`${t.priority} IN ('low', 'normal', 'high', 'urgent')`),
    check(
      "tickets_channel_chk",
      sql`${t.channel} IN ('email', 'chat', 'whatsapp', 'phone', 'web', 'api', 'manual')`,
    ),
  ],
)

export type SupportTicketRow = typeof tickets.$inferSelect
export type NewSupportTicketRow = typeof tickets.$inferInsert

export const ticketComments = pgTable(
  "ticket_comments",
  {
    ...baseColumns,
    ...workspaceColumn,
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    // Cross-module reference (plain uuid, NO foreign key — see header). users.id.
    authorId: uuid("author_id").notNull(),
    body: text("body").notNull(),
    /**
     * Internal notes are staff-only. Never expose a row with
     * `isInternal === true` on any endpoint a requester could reach — the
     * domain service enforces this by construction (see the `getForStaff` /
     * `getForRequester` split in `packages/crm/src/support/service.ts`),
     * not by trusting callers to check this flag themselves.
     */
    isInternal: boolean("is_internal").notNull().default(false),
  },
  (t) => [
    index("ticket_comments_ticket_idx").on(t.ticketId),
    index("ticket_comments_workspace_idx").on(t.workspaceId),
  ],
)

export type SupportTicketCommentRow = typeof ticketComments.$inferSelect
export type NewSupportTicketCommentRow = typeof ticketComments.$inferInsert
