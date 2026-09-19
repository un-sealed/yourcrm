import { boolean, index, integer, jsonb, pgTable, text, varchar } from "drizzle-orm/pg-core"
import { baseColumns, ownerColumn, workspaceColumn } from "./base"

/**
 * Import / Export module tables (spec 30-import-export, P0 CSV only).
 *
 * - `import_jobs`: one row per CSV import (upload -> column mapping ->
 *   dry-run preview -> background execution). Generic over `object_type`
 *   (person, company, lead, ...); no per-object special-casing.
 * - `export_jobs`: one row per CSV export. Exports obey the caller's
 *   permissions (checked in the domain service) and record an audit row.
 *
 * `object_type` references are PLAIN values with NO foreign key — target
 * module tables may not exist yet (same rule as people.company_id).
 * Mapping payloads and row-error previews live in JSONB so the P0 slice
 * needs no extra tables; dedicated ImportMapping / ImportRowError /
 * MigrationJob tables are deferred to a later pass.
 */

export const IMPORT_JOB_STATUSES = [
  "pending",
  "validating",
  "validated",
  "running",
  "completed",
  "failed",
  "canceled",
] as const

export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number]

export function isImportJobStatus(value: unknown): value is ImportJobStatus {
  return typeof value === "string" && (IMPORT_JOB_STATUSES as readonly string[]).includes(value)
}

export const IMPORT_MODES = ["create", "update", "upsert"] as const

export type ImportMode = (typeof IMPORT_MODES)[number]

export function isImportMode(value: unknown): value is ImportMode {
  return typeof value === "string" && (IMPORT_MODES as readonly string[]).includes(value)
}

export const TRANSFER_FORMATS = ["csv"] as const

export type TransferFormat = (typeof TRANSFER_FORMATS)[number]

export function isTransferFormat(value: unknown): value is TransferFormat {
  return typeof value === "string" && (TRANSFER_FORMATS as readonly string[]).includes(value)
}

export const EXPORT_JOB_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "canceled",
] as const

export type ExportJobStatus = (typeof EXPORT_JOB_STATUSES)[number]

export function isExportJobStatus(value: unknown): value is ExportJobStatus {
  return typeof value === "string" && (EXPORT_JOB_STATUSES as readonly string[]).includes(value)
}

export const importJobs = pgTable(
  "import_jobs",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    // Generic object type (person, company, lead, ...). Plain value, no FK:
    // the target module's table may not exist yet.
    objectType: varchar("object_type", { length: 64 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    mode: varchar("mode", { length: 32 }).notNull().default("create"),
    // P0 is CSV only; excel/json are deferred.
    format: varchar("format", { length: 16 }).notNull().default("csv"),
    fileName: varchar("file_name", { length: 255 }),
    // Column mapping: source header -> target field.
    mapping: jsonb("mapping"),
    totalRows: integer("total_rows").notNull().default(0),
    processedRows: integer("processed_rows").notNull().default(0),
    succeededRows: integer("succeeded_rows").notNull().default(0),
    failedRows: integer("failed_rows").notNull().default(0),
    skippedRows: integer("skipped_rows").notNull().default(0),
    dryRun: boolean("dry_run").notNull().default(false),
    // Dry-run / execution row-error preview (JSON array).
    errors: jsonb("errors"),
    errorReport: text("error_report"),
  },
  (t) => [
    index("import_jobs_workspace_idx").on(t.workspaceId),
    index("import_jobs_status_idx").on(t.workspaceId, t.status),
    index("import_jobs_object_idx").on(t.workspaceId, t.objectType),
  ],
)

export type ImportJob = typeof importJobs.$inferSelect
export type NewImportJob = typeof importJobs.$inferInsert

export const exportJobs = pgTable(
  "export_jobs",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    // Generic object type (person, company, lead, ...). Plain value, no FK:
    // the target module's table may not exist yet.
    objectType: varchar("object_type", { length: 64 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    // P0 is CSV only; excel/json are deferred.
    format: varchar("format", { length: 16 }).notNull().default("csv"),
    fileName: varchar("file_name", { length: 255 }),
    // Structured filter snapshot used for the export.
    filters: jsonb("filters"),
    totalRows: integer("total_rows").notNull().default(0),
    // Temporary file location (bytes live in S3/MinIO per architecture).
    filePath: text("file_path"),
  },
  (t) => [
    index("export_jobs_workspace_idx").on(t.workspaceId),
    index("export_jobs_status_idx").on(t.workspaceId, t.status),
    index("export_jobs_object_idx").on(t.workspaceId, t.objectType),
  ],
)

export type ExportJob = typeof exportJobs.$inferSelect
export type NewExportJob = typeof exportJobs.$inferInsert
