import { sql } from "drizzle-orm"
import { index, integer, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core"
import { baseColumns, ownerColumn, workspaceColumn } from "./base"

/**
 * Files module tables (spec 29-files, P0).
 *
 * - `files`: one metadata row per stored object. Bytes live in S3/MinIO
 *   (`@yourcrm/storage`); Postgres keeps metadata only. The API mints
 *   presigned upload/download URLs and never proxies bytes.
 * - `subject_type` + `subject_id` are PLAIN columns with NO foreign key: the
 *   people/companies/deals tables may not exist yet when this migration runs
 *   (same rule as people.company_id). `subject_id` holds the id of the
 *   attached record — a person, company or deal — and `subject_type` names
 *   which one. Foreign keys across modules are added in a later integration
 *   pass.
 */

export const FILE_SUBJECT_TYPES = ["person", "company", "deal"] as const

export type FileSubjectType = (typeof FILE_SUBJECT_TYPES)[number]

export function isFileSubjectType(value: unknown): value is FileSubjectType {
  return typeof value === "string" && (FILE_SUBJECT_TYPES as readonly string[]).includes(value)
}

export const files = pgTable(
  "files",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    fileName: varchar("file_name", { length: 255 }).notNull(),
    mimeType: varchar("mime_type", { length: 128 }),
    sizeBytes: integer("size_bytes").notNull().default(0),
    storageKey: text("storage_key").notNull(),
    subjectType: varchar("subject_type", { length: 64 }),
    subjectId: uuid("subject_id"),
    description: text("description"),
  },
  (t) => [
    index("files_workspace_idx").on(t.workspaceId),
    index("files_subject_idx").on(t.subjectType, t.subjectId),
    index("files_mime_idx").on(t.workspaceId, t.mimeType),
    index("files_name_idx").on(t.workspaceId, sql`lower(${t.fileName})`),
  ],
)

export type File = typeof files.$inferSelect
export type NewFile = typeof files.$inferInsert
