import { and, eq, ilike, isNull, or, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import {
  exportJobs,
  importJobs,
  isExportJobStatus,
  isImportJobStatus,
  isImportMode,
  type ExportJob,
  type ImportJob,
  type NewExportJob,
  type NewImportJob,
} from "../schema/import-export"
import { createBaseRepository } from "./base-repository"

export type CreateImportJobInput = {
  objectType: string
  mode?: string | null
  format?: string | null
  fileName?: string | null
  ownerId?: string | null
  mapping?: Record<string, string> | null
  totalRows?: number | null
  dryRun?: boolean | null
}

export type UpdateImportJobInput = Partial<
  Pick<NewImportJob, "fileName" | "ownerId" | "mapping" | "errors" | "errorReport">
> & {
  status?: string | null
  mode?: string | null
  totalRows?: number | null
  processedRows?: number | null
  succeededRows?: number | null
  failedRows?: number | null
  skippedRows?: number | null
  dryRun?: boolean | null
}

export type CreateExportJobInput = {
  objectType: string
  format?: string | null
  fileName?: string | null
  ownerId?: string | null
  filters?: Record<string, unknown> | null
  totalRows?: number | null
  filePath?: string | null
}

export type UpdateExportJobInput = Partial<
  Pick<NewExportJob, "fileName" | "ownerId" | "filters" | "filePath">
> & {
  status?: string | null
  totalRows?: number | null
}

function normalizeObjectType(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\s+/g, "_")
  if (trimmed.length === 0) throw new Error("import-export.create: objectType must not be empty")
  if (trimmed.length > 64)
    throw new Error("import-export.create: objectType must be at most 64 characters")
  return trimmed
}

function toCount(value: number | null | undefined, field: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`import-export.create: ${field} must be a non-negative integer`)
  return value
}

type ImportJobValues = {
  fileName?: string | null
  ownerId?: string | null
  mapping?: Record<string, string> | null
  errors?: unknown
  errorReport?: string | null
  status?: string | null
  mode?: string | null
  totalRows?: number | null
  processedRows?: number | null
  succeededRows?: number | null
  failedRows?: number | null
  skippedRows?: number | null
  dryRun?: boolean | null
}

function toImportValues(workspaceId: string, input: ImportJobValues, actorId?: string): Partial<NewImportJob> {
  const values: Partial<NewImportJob> = {}
  if (input.fileName !== undefined) values.fileName = input.fileName?.trim() || null
  if (input.ownerId !== undefined) values.ownerId = input.ownerId
  if (input.mapping !== undefined) values.mapping = input.mapping
  if (input.errors !== undefined) values.errors = input.errors
  if (input.errorReport !== undefined) values.errorReport = input.errorReport
  if (input.status !== undefined) {
    if (input.status !== null && !isImportJobStatus(input.status)) {
      throw new Error(
        "import-export.create: status must be one of pending, validating, validated, " +
          "running, completed, failed, canceled",
      )
    }
    if (input.status !== null) values.status = input.status
  }
  if (input.mode !== undefined) {
    if (input.mode !== null && !isImportMode(input.mode)) {
      throw new Error("import-export.create: mode must be one of create, update, upsert")
    }
    if (input.mode !== null) values.mode = input.mode
  }
  if (input.totalRows !== undefined) {
    const count = toCount(input.totalRows, "totalRows")
    if (count !== undefined) values.totalRows = count
  }
  if (input.processedRows !== undefined) {
    const count = toCount(input.processedRows, "processedRows")
    if (count !== undefined) values.processedRows = count
  }
  if (input.succeededRows !== undefined) {
    const count = toCount(input.succeededRows, "succeededRows")
    if (count !== undefined) values.succeededRows = count
  }
  if (input.failedRows !== undefined) {
    const count = toCount(input.failedRows, "failedRows")
    if (count !== undefined) values.failedRows = count
  }
  if (input.skippedRows !== undefined) {
    const count = toCount(input.skippedRows, "skippedRows")
    if (count !== undefined) values.skippedRows = count
  }
  if (input.dryRun !== undefined && input.dryRun !== null) values.dryRun = input.dryRun
  if (actorId !== undefined) {
    values.updatedBy = actorId
  }
  return { ...values, workspaceId }
}

type ExportJobValues = {
  fileName?: string | null
  ownerId?: string | null
  filters?: Record<string, unknown> | null
  filePath?: string | null
  status?: string | null
  totalRows?: number | null
}

function toExportValues(
  workspaceId: string,
  input: ExportJobValues,
  actorId?: string,
): Partial<NewExportJob> {
  const values: Partial<NewExportJob> = {}
  if (input.fileName !== undefined) values.fileName = input.fileName?.trim() || null
  if (input.ownerId !== undefined) values.ownerId = input.ownerId
  if (input.filters !== undefined) values.filters = input.filters
  if (input.filePath !== undefined) values.filePath = input.filePath
  if (input.status !== undefined) {
    if (input.status !== null && !isExportJobStatus(input.status)) {
      throw new Error(
        "import-export.create: status must be one of pending, running, completed, failed, canceled",
      )
    }
    if (input.status !== null) values.status = input.status
  }
  if (input.totalRows !== undefined) {
    const count = toCount(input.totalRows, "totalRows")
    if (count !== undefined) values.totalRows = count
  }
  if (actorId !== undefined) {
    values.updatedBy = actorId
  }
  return { ...values, workspaceId }
}

/**
 * Workspace-scoped import/export job repositories. `objectType` stays a
 * plain value (no join) until every target module lands; file bytes live in
 * S3/MinIO and only metadata + counts live here.
 */
export function createImportJobsRepository() {
  const base = createBaseRepository(importJobs)

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateImportJobInput,
      actorId?: string,
    ): Promise<ImportJob> {
      const rows = await db
        .insert(importJobs)
        .values({
          ...toImportValues(workspaceId, input, actorId),
          workspaceId,
          objectType: normalizeObjectType(input.objectType),
          mode: input.mode ?? "create",
          format: "csv",
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("import-export.create: insert returned no rows")
      return row
    },

    /** Cursor-paginated list with optional object-type/status search. */
    async search(
      db: Database,
      opts: { workspaceId: string; limit?: number; cursor?: string; order?: "asc" | "desc" } & {
        query?: string
        status?: string
        objectType?: string
      },
    ) {
      const conditions: SQL[] = []
      if (opts.query) {
        const q = `%${opts.query.trim()}%`
        const match = or(ilike(importJobs.objectType, q), ilike(importJobs.fileName, q))
        if (match) conditions.push(match)
      }
      if (opts.status) {
        if (!isImportJobStatus(opts.status))
          throw new Error("import-export.search: unknown status filter")
        conditions.push(eq(importJobs.status, opts.status))
      }
      if (opts.objectType) {
        conditions.push(eq(importJobs.objectType, normalizeObjectType(opts.objectType)))
      }
      const result = await base.list(db, { ...opts, where: conditions })
      return { data: result.data as ImportJob[], pagination: result.pagination }
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateImportJobInput,
      actorId?: string,
    ): Promise<ImportJob | null> {
      const rows = await db
        .update(importJobs)
        .set({ ...toImportValues(workspaceId, input, actorId), updatedAt: new Date() })
        .where(
          and(
            eq(importJobs.id, id),
            eq(importJobs.workspaceId, workspaceId),
            isNull(importJobs.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    async findById(db: Database, workspaceId: string, id: string): Promise<ImportJob | null> {
      // The shared base narrows rows to the BaseRecord columns; re-select the
      // concrete table here so callers get the full ImportJob shape.
      const row = await base.findById(db, workspaceId, id)
      return (row as ImportJob | null) ?? null
    },
  }
}

export function createExportJobsRepository() {
  const base = createBaseRepository(exportJobs)

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateExportJobInput,
      actorId?: string,
    ): Promise<ExportJob> {
      const rows = await db
        .insert(exportJobs)
        .values({
          ...toExportValues(workspaceId, input, actorId),
          workspaceId,
          objectType: normalizeObjectType(input.objectType),
          format: "csv",
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("import-export.create: insert returned no rows")
      return row
    },

    /** Cursor-paginated list with optional object-type/status search. */
    async search(
      db: Database,
      opts: { workspaceId: string; limit?: number; cursor?: string; order?: "asc" | "desc" } & {
        query?: string
        status?: string
        objectType?: string
      },
    ) {
      const conditions: SQL[] = []
      if (opts.query) {
        const q = `%${opts.query.trim()}%`
        const match = or(ilike(exportJobs.objectType, q), ilike(exportJobs.fileName, q))
        if (match) conditions.push(match)
      }
      if (opts.status) {
        if (!isExportJobStatus(opts.status))
          throw new Error("import-export.search: unknown status filter")
        conditions.push(eq(exportJobs.status, opts.status))
      }
      if (opts.objectType) {
        conditions.push(eq(exportJobs.objectType, normalizeObjectType(opts.objectType)))
      }
      const result = await base.list(db, { ...opts, where: conditions })
      return { data: result.data as ExportJob[], pagination: result.pagination }
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateExportJobInput,
      actorId?: string,
    ): Promise<ExportJob | null> {
      const rows = await db
        .update(exportJobs)
        .set({ ...toExportValues(workspaceId, input, actorId), updatedAt: new Date() })
        .where(
          and(
            eq(exportJobs.id, id),
            eq(exportJobs.workspaceId, workspaceId),
            isNull(exportJobs.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    async findById(db: Database, workspaceId: string, id: string): Promise<ExportJob | null> {
      const row = await base.findById(db, workspaceId, id)
      return (row as ExportJob | null) ?? null
    },
  }
}

export type ImportJobsRepository = ReturnType<typeof createImportJobsRepository>
export type ExportJobsRepository = ReturnType<typeof createExportJobsRepository>
