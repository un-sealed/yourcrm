import { sql } from "drizzle-orm"
import { index, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core"
import { baseColumns, ownerColumn, workspaceColumn } from "./base"

/**
 * Activities module tables (spec 11-activities, P0).
 *
 * - `activities`: one row per activity (note, call, meeting, email).
 *   `subject_type` + `subject_id` are PLAIN columns with an index and NO
 *   foreign key — the referenced tables (people, companies, deals, leads)
 *   may not exist yet when this migration runs. `subject_type` is one of
 *   `person` | `company` | `deal` | `lead`, naming the owning module's
 *   table; `subject_id` is that record's uuid. This is the reusable
 *   timeline seam: other modules query by (subject_type, subject_id).
 * - Email body storage is out of scope for P0: `body` holds note text,
 *   call notes or meeting agendas only.
 */

export const ACTIVITY_TYPES = ["note", "call", "meeting", "email"] as const

export type ActivityType = (typeof ACTIVITY_TYPES)[number]

export function isActivityType(value: unknown): value is ActivityType {
  return typeof value === "string" && (ACTIVITY_TYPES as readonly string[]).includes(value)
}

export const ACTIVITY_STATUSES = ["open", "completed", "cancelled"] as const

export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number]

export function isActivityStatus(value: unknown): value is ActivityStatus {
  return typeof value === "string" && (ACTIVITY_STATUSES as readonly string[]).includes(value)
}

export const ACTIVITY_SUBJECT_TYPES = ["person", "company", "deal", "lead"] as const

export type ActivitySubjectType = (typeof ACTIVITY_SUBJECT_TYPES)[number]

export function isActivitySubjectType(value: unknown): value is ActivitySubjectType {
  return typeof value === "string" && (ACTIVITY_SUBJECT_TYPES as readonly string[]).includes(value)
}

export const activities = pgTable(
  "activities",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    title: varchar("title", { length: 255 }).notNull(),
    type: varchar("type", { length: 32 }).notNull().default("note"),
    // Polymorphic association: plain columns, NO foreign key (see header).
    // subject_type names the owning module record (person, company, deal,
    // lead); subject_id is that record's uuid.
    subjectType: varchar("subject_type", { length: 64 }),
    subjectId: uuid("subject_id"),
    body: text("body"),
    status: varchar("status", { length: 32 }).notNull().default("open"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("activities_workspace_idx").on(t.workspaceId),
    index("activities_type_idx").on(t.workspaceId, t.type),
    index("activities_status_idx").on(t.workspaceId, t.status),
    index("activities_subject_idx").on(t.subjectType, t.subjectId),
    index("activities_title_idx").on(t.workspaceId, sql`lower(${t.title})`),
  ],
)

export type Activity = typeof activities.$inferSelect
export type NewActivity = typeof activities.$inferInsert
