import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"

/**
 * Import / Export service ports (mirrors the people module pattern).
 *
 * `@yourcrm/crm` has no database dependency, so the service never imports
 * `@yourcrm/database`. It depends on these structural ports instead; the API
 * layer adapts the drizzle repositories (`import-export-repository.ts`) and
 * `writeAudit` to them. Any object with matching methods satisfies the
 * port — including the `createStore` fake in hermetic tests.
 */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type ImportJobRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
}

export type ExportJobRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
}

export type ImportJobListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
  status?: string
  objectType?: string
}

export type ExportJobListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
  status?: string
  objectType?: string
}

export type ImportJobListResult = {
  data: ImportJobRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type ExportJobListResult = {
  data: ExportJobRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type DryRunPreview = {
  totalRows: number
  validRows: number
  invalidRows: number
  missingColumns: string[]
  errors: { row: number; column: string | null; message: string }[]
}

export type ImportExportStore = {
  listImports(workspaceId: string, query: ImportJobListQuery): Promise<ImportJobListResult>
  findImportById(workspaceId: string, id: string): Promise<ImportJobRecord | null>
  createImport(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<ImportJobRecord>
  updateImport(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<ImportJobRecord | null>
  softDeleteImport(workspaceId: string, id: string, actorId?: string): Promise<void>
  restoreImport(workspaceId: string, id: string): Promise<void>
  listExports(workspaceId: string, query: ExportJobListQuery): Promise<ExportJobListResult>
  findExportById(workspaceId: string, id: string): Promise<ExportJobRecord | null>
  createExport(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<ExportJobRecord>
  updateExport(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<ExportJobRecord | null>
  softDeleteExport(workspaceId: string, id: string, actorId?: string): Promise<void>
  restoreExport(workspaceId: string, id: string): Promise<void>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type ImportExportAuditInput = {
  workspaceId: string
  actorId?: string | null
  action: string
  object: string
  recordId?: string | null
  before?: unknown
  after?: unknown
  correlationId?: string | null
  source?: "user" | "automation" | "ai" | "integration" | "mcp"
}

export type ImportExportServiceContext = ServiceContext

export type ImportExportServiceDeps = {
  store: ImportExportStore
  audit: AuditWriter<ImportExportAuditInput>
  events?: EventEmitter
}
