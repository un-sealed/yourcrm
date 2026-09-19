import { index, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core"
import { baseColumns, ownerColumn, workspaceColumn } from "./base"

/**
 * Tasks module tables (spec 12-tasks, P0).
 *
 * - `tasks`: one row per task. `person_id`, `company_id` and `deal_id` are
 *   PLAIN uuid columns with indexes and NO foreign keys — those tables are
 *   owned by other module agents and may not exist yet when this migration
 *   runs (same rule as people.company_id). Cross-module FKs are added in a
 *   later integration pass.
 * - Completion is `status = 'completed'` plus `completed_at`; reopening
 *   clears both. `assignee_id` drives the "My tasks" filter.
 */

export const TASK_STATUSES = ["open", "in_progress", "completed", "archived"] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value)
}

export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const

export type TaskPriority = (typeof TASK_PRIORITIES)[number]

export function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === "string" && (TASK_PRIORITIES as readonly string[]).includes(value)
}

export const tasks = pgTable(
  "tasks",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    status: varchar("status", { length: 32 }).notNull().default("open"),
    priority: varchar("priority", { length: 32 }).notNull().default("medium"),
    dueDate: timestamp("due_date", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    assigneeId: uuid("assignee_id"),
    // Cross-module references (plain uuid, no FK — see header comment).
    personId: uuid("person_id"),
    companyId: uuid("company_id"),
    dealId: uuid("deal_id"),
  },
  (t) => [
    index("tasks_workspace_idx").on(t.workspaceId),
    index("tasks_status_idx").on(t.workspaceId, t.status),
    index("tasks_priority_idx").on(t.workspaceId, t.priority),
    index("tasks_assignee_idx").on(t.workspaceId, t.assigneeId),
    index("tasks_due_idx").on(t.workspaceId, t.dueDate),
    index("tasks_person_idx").on(t.personId),
    index("tasks_company_idx").on(t.companyId),
    index("tasks_deal_idx").on(t.dealId),
  ],
)

export type Task = typeof tasks.$inferSelect
export type NewTask = typeof tasks.$inferInsert
