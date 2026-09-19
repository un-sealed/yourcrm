import { TransferEvents, createEvent, getEventBus } from "@yourcrm/events"
import { requirePermission } from "@yourcrm/permissions"
import { paginationQuerySchema } from "@yourcrm/validation"
import { z } from "zod"
import type {
  DryRunPreview,
  ExportJobListResult,
  ImportExportServiceContext,
  ImportExportServiceDeps,
  ImportJobListResult,
  ImportJobRecord,
  ExportJobRecord,
} from "./types"

/**
 * Import / Export zod schemas. The service validates inputs with these; API
 * routes reuse them at the HTTP boundary via `@hono/zod-validator`.
 * (Kept in the service file — unlike people — so the module stays within
 * its four assigned `packages/crm` files.)
 */

const objectTypeSchema = z.string().trim().min(1).max(64)
const fileNameSchema = z.string().trim().min(1).max(255)
const mappingSchema = z.record(z.string().trim().min(1).max(255), z.string().trim().min(1).max(255))

export const createImportJobSchema = z.object({
  objectType: objectTypeSchema,
  mode: z.enum(["create", "update", "upsert"]).nullish(),
  format: z.enum(["csv"]).nullish(),
  fileName: fileNameSchema.nullish(),
  ownerId: z.string().min(1).nullish(),
  mapping: mappingSchema.nullish(),
  totalRows: z.number().int().min(0).nullish(),
  dryRun: z.boolean().nullish(),
})

export type CreateImportJobInput = z.infer<typeof createImportJobSchema>

export const updateImportJobSchema = z
  .object({
    status: z
      .enum(["pending", "validating", "validated", "running", "completed", "failed", "canceled"])
      .nullish(),
    mode: z.enum(["create", "update", "upsert"]).nullish(),
    fileName: fileNameSchema.nullish(),
    ownerId: z.string().min(1).nullish(),
    mapping: mappingSchema.nullish(),
    totalRows: z.number().int().min(0).nullish(),
    processedRows: z.number().int().min(0).nullish(),
    succeededRows: z.number().int().min(0).nullish(),
    failedRows: z.number().int().min(0).nullish(),
    skippedRows: z.number().int().min(0).nullish(),
    dryRun: z.boolean().nullish(),
    errorReport: z.string().max(10000).nullish(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateImportJobInput = z.infer<typeof updateImportJobSchema>

export const importJobQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
  status: z
    .enum(["pending", "validating", "validated", "running", "completed", "failed", "canceled"])
    .optional(),
  objectType: z.string().trim().min(1).max(64).optional(),
})

export type ImportJobQuery = z.infer<typeof importJobQuerySchema>

export const createExportJobSchema = z.object({
  objectType: objectTypeSchema,
  format: z.enum(["csv"]).nullish(),
  fileName: fileNameSchema.nullish(),
  ownerId: z.string().min(1).nullish(),
  filters: z.record(z.unknown()).nullish(),
  totalRows: z.number().int().min(0).nullish(),
  filePath: z.string().trim().max(2000).nullish(),
})

export type CreateExportJobInput = z.infer<typeof createExportJobSchema>

export const updateExportJobSchema = z
  .object({
    status: z.enum(["pending", "running", "completed", "failed", "canceled"]).nullish(),
    fileName: fileNameSchema.nullish(),
    ownerId: z.string().min(1).nullish(),
    filters: z.record(z.unknown()).nullish(),
    totalRows: z.number().int().min(0).nullish(),
    filePath: z.string().trim().max(2000).nullish(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateExportJobInput = z.infer<typeof updateExportJobSchema>

export const exportJobQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
  status: z.enum(["pending", "running", "completed", "failed", "canceled"]).optional(),
  objectType: z.string().trim().min(1).max(64).optional(),
})

export type ExportJobQuery = z.infer<typeof exportJobQuerySchema>

export const dryRunImportSchema = z.object({
  // P0 is CSV only: raw file text plus the column mapping to preview.
  csvText: z.string().min(1).max(5_000_000),
  mapping: mappingSchema.optional(),
})

export type DryRunImportInput = z.infer<typeof dryRunImportSchema>

export const completeImportSchema = z.object({
  succeededRows: z.number().int().min(0).default(0),
  failedRows: z.number().int().min(0).default(0),
  skippedRows: z.number().int().min(0).default(0),
  errors: z
    .array(z.object({ row: z.number().int().min(1), message: z.string().max(1000) }))
    .max(500)
    .default([]),
})

export type CompleteImportInput = z.infer<typeof completeImportSchema>

export const importJobSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  objectType: z.string(),
  status: z.string(),
  mode: z.string(),
  format: z.string(),
  fileName: z.string().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  totalRows: z.number().nullable().optional(),
  processedRows: z.number().nullable().optional(),
  succeededRows: z.number().nullable().optional(),
  failedRows: z.number().nullable().optional(),
  skippedRows: z.number().nullable().optional(),
  dryRun: z.boolean().nullable().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type ImportJobDto = z.infer<typeof importJobSchema>

export const exportJobSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  objectType: z.string(),
  status: z.string(),
  format: z.string(),
  fileName: z.string().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  totalRows: z.number().nullable().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type ExportJobDto = z.infer<typeof exportJobSchema>

export class ImportJobNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`import job ${id} not found`)
    this.name = "ImportJobNotFoundError"
  }
}

export class ExportJobNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`export job ${id} not found`)
    this.name = "ExportJobNotFoundError"
  }
}

function permissionOf(
  ctx: ImportExportServiceContext,
  action: "read" | "create" | "update" | "delete" | "export",
) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "import_export",
    action,
  }
}

/**
 * Minimal CSV parser (P0, no dependency): splits rows on newlines, honors
 * double-quoted fields with `""` escapes. Returns headers + row objects.
 */
export function parseCsvRows(csvText: string): { headers: string[]; rows: string[][] } {
  const rows: string[][] = []
  let field = ""
  let row: string[] = []
  let quoted = false
  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i]
    if (quoted) {
      if (ch === '"') {
        if (csvText[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ",") {
      row.push(field)
      field = ""
    } else if (ch === "\n") {
      row.push(field)
      field = ""
      rows.push(row)
      row = []
    } else if (ch === "\r") {
      // Tolerate CRLF: the following \n terminates the row.
    } else {
      field += ch
    }
  }
  row.push(field)
  rows.push(row)
  const nonEmpty = rows.filter((r) => !(r.length === 1 && (r[0] ?? "").trim() === ""))
  const headers = (nonEmpty[0] ?? []).map((h) => h.trim())
  return { headers, rows: nonEmpty.slice(1) }
}

/**
 * Dry-run validation preview: checks the mapping covers the CSV headers and
 * flags empty mapped values per row. Pure function of its inputs (safe to
 * retry, mirrors the background worker's validation step).
 */
export function previewDryRun(csvText: string, mapping?: Record<string, string>): DryRunPreview {
  const { headers, rows } = parseCsvRows(csvText)
  const active = mapping ?? Object.fromEntries(headers.map((h) => [h, h]))
  const missingColumns = Object.keys(active).filter((source) => !headers.includes(source))
  const indexOf = new Map(headers.map((h, i) => [h, i] as [string, number]))
  const errors: DryRunPreview["errors"] = []
  let validRows = 0
  rows.forEach((cells, i) => {
    const rowNumber = i + 1
    const rowErrors: DryRunPreview["errors"] = []
    for (const [source, target] of Object.entries(active)) {
      const idx = indexOf.get(source)
      if (idx === undefined) continue
      if (((cells[idx] ?? "").trim()) === "") {
        rowErrors.push({ row: rowNumber, column: target, message: "empty value" })
      }
    }
    if (rowErrors.length === 0) validRows++
    errors.push(...rowErrors.slice(0, 5))
  })
  const totalRows = rows.length
  return {
    totalRows,
    validRows,
    invalidRows: totalRows - validRows,
    missingColumns,
    errors: errors.slice(0, 100),
  }
}

/**
 * Import / Export domain service (mirrors the people service shape).
 *
 * Every method:
 *  1. calls `requirePermission()` FIRST, before any read or write;
 *  2. does the work through the injected `ImportExportStore` port;
 *  3. emits the domain event via the `TransferEvents` constant (never a literal);
 *  4. writes the audit row with before/after (mutations only).
 */
export function createImportExportService(deps: ImportExportServiceDeps) {
  const events = deps.events ?? getEventBus()

  async function listImports(
    ctx: ImportExportServiceContext,
    rawQuery: unknown,
  ): Promise<ImportJobListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = importJobQuerySchema.parse(rawQuery)
    return deps.store.listImports(ctx.workspaceId, query)
  }

  async function getImport(ctx: ImportExportServiceContext, id: string): Promise<ImportJobRecord> {
    requirePermission(permissionOf(ctx, "read"))
    const found = await deps.store.findImportById(ctx.workspaceId, id)
    if (!found) throw new ImportJobNotFoundError(id)
    return found
  }

  async function createImport(
    ctx: ImportExportServiceContext,
    rawInput: unknown,
  ): Promise<ImportJobRecord> {
    requirePermission(permissionOf(ctx, "create"))
    const input = createImportJobSchema.parse(rawInput)
    const job = await deps.store.createImport(
      ctx.workspaceId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    await events.emit(
      createEvent({
        event: TransferEvents.ImportStarted,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "import_job",
        entityId: job.id,
        after: job,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "import_job",
      recordId: job.id,
      after: job,
      correlationId: ctx.correlationId,
    })
    return job
  }

  async function updateImport(
    ctx: ImportExportServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<ImportJobRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const patch = updateImportJobSchema.parse(rawPatch)
    const before = await deps.store.findImportById(ctx.workspaceId, id)
    if (!before) throw new ImportJobNotFoundError(id)
    const after = await deps.store.updateImport(
      ctx.workspaceId,
      id,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new ImportJobNotFoundError(id)
    await events.emit(
      createEvent({
        event: TransferEvents.ImportCompleted,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "import_job",
        entityId: id,
        before,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "import_job",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function softDeleteImport(
    ctx: ImportExportServiceContext,
    id: string,
  ): Promise<ImportJobRecord> {
    requirePermission(permissionOf(ctx, "delete"))
    const before = await deps.store.findImportById(ctx.workspaceId, id)
    if (!before) throw new ImportJobNotFoundError(id)
    await deps.store.softDeleteImport(ctx.workspaceId, id, ctx.actorId)
    await events.emit(
      createEvent({
        event: TransferEvents.ImportCompleted,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "import_job",
        entityId: id,
        before,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "import_job",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function restoreImport(
    ctx: ImportExportServiceContext,
    id: string,
  ): Promise<ImportJobRecord> {
    requirePermission(permissionOf(ctx, "update"))
    await deps.store.restoreImport(ctx.workspaceId, id)
    const after = await deps.store.findImportById(ctx.workspaceId, id)
    if (!after) throw new ImportJobNotFoundError(id)
    await events.emit(
      createEvent({
        event: TransferEvents.ImportCompleted,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "import_job",
        entityId: id,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "restore",
      object: "import_job",
      recordId: id,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /** Read-only dry-run preview: no mutation, no event, no audit row. */
  async function dryRunImport(
    ctx: ImportExportServiceContext,
    id: string,
    rawInput: unknown,
  ): Promise<DryRunPreview> {
    requirePermission(permissionOf(ctx, "read"))
    const input = dryRunImportSchema.parse(rawInput)
    const job = await deps.store.findImportById(ctx.workspaceId, id)
    if (!job) throw new ImportJobNotFoundError(id)
    const stored = job["mapping"] as Record<string, string> | null | undefined
    return previewDryRun(input.csvText, input.mapping ?? stored ?? undefined)
  }

  /** Background worker completion callback: records counts, closes the job. */
  async function completeImport(
    ctx: ImportExportServiceContext,
    id: string,
    rawInput: unknown,
  ): Promise<ImportJobRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const input = completeImportSchema.parse(rawInput)
    const before = await deps.store.findImportById(ctx.workspaceId, id)
    if (!before) throw new ImportJobNotFoundError(id)
    const total = input.succeededRows + input.failedRows + input.skippedRows
    const after = await deps.store.updateImport(
      ctx.workspaceId,
      id,
      {
        status: "completed",
        processedRows: total,
        succeededRows: input.succeededRows,
        failedRows: input.failedRows,
        skippedRows: input.skippedRows,
        errors: input.errors,
      },
      ctx.actorId,
    )
    if (!after) throw new ImportJobNotFoundError(id)
    await events.emit(
      createEvent({
        event: TransferEvents.ImportCompleted,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "import_job",
        entityId: id,
        before,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "complete",
      object: "import_job",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function listExports(
    ctx: ImportExportServiceContext,
    rawQuery: unknown,
  ): Promise<ExportJobListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = exportJobQuerySchema.parse(rawQuery)
    return deps.store.listExports(ctx.workspaceId, query)
  }

  async function getExport(ctx: ImportExportServiceContext, id: string): Promise<ExportJobRecord> {
    requirePermission(permissionOf(ctx, "read"))
    const found = await deps.store.findExportById(ctx.workspaceId, id)
    if (!found) throw new ExportJobNotFoundError(id)
    return found
  }

  async function createExport(
    ctx: ImportExportServiceContext,
    rawInput: unknown,
  ): Promise<ExportJobRecord> {
    // Exports obey the caller's permissions: the dedicated `export` action
    // (member+) rather than plain `create`, so viewers cannot exfiltrate.
    requirePermission(permissionOf(ctx, "export"))
    const input = createExportJobSchema.parse(rawInput)
    const job = await deps.store.createExport(
      ctx.workspaceId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    await events.emit(
      createEvent({
        event: TransferEvents.ExportCompleted,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "export_job",
        entityId: job.id,
        after: job,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "export_job",
      recordId: job.id,
      after: job,
      correlationId: ctx.correlationId,
    })
    return job
  }

  async function updateExport(
    ctx: ImportExportServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<ExportJobRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const patch = updateExportJobSchema.parse(rawPatch)
    const before = await deps.store.findExportById(ctx.workspaceId, id)
    if (!before) throw new ExportJobNotFoundError(id)
    const after = await deps.store.updateExport(
      ctx.workspaceId,
      id,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new ExportJobNotFoundError(id)
    await events.emit(
      createEvent({
        event: TransferEvents.ExportCompleted,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "export_job",
        entityId: id,
        before,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "export_job",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function softDeleteExport(
    ctx: ImportExportServiceContext,
    id: string,
  ): Promise<ExportJobRecord> {
    requirePermission(permissionOf(ctx, "delete"))
    const before = await deps.store.findExportById(ctx.workspaceId, id)
    if (!before) throw new ExportJobNotFoundError(id)
    await deps.store.softDeleteExport(ctx.workspaceId, id, ctx.actorId)
    await events.emit(
      createEvent({
        event: TransferEvents.ExportCompleted,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "export_job",
        entityId: id,
        before,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "export_job",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function restoreExport(
    ctx: ImportExportServiceContext,
    id: string,
  ): Promise<ExportJobRecord> {
    requirePermission(permissionOf(ctx, "update"))
    await deps.store.restoreExport(ctx.workspaceId, id)
    const after = await deps.store.findExportById(ctx.workspaceId, id)
    if (!after) throw new ExportJobNotFoundError(id)
    await events.emit(
      createEvent({
        event: TransferEvents.ExportCompleted,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "export_job",
        entityId: id,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "restore",
      object: "export_job",
      recordId: id,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  return {
    listImports,
    getImport,
    createImport,
    updateImport,
    softDeleteImport,
    restoreImport,
    dryRunImport,
    completeImport,
    listExports,
    getExport,
    createExport,
    updateExport,
    softDeleteExport,
    restoreExport,
  }
}

export type ImportExportService = ReturnType<typeof createImportExportService>
