import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"

/**
 * Reports service ports (mirrors the `people` reference module).
 *
 * `@yourcrm/crm` has no database dependency, so the service never imports
 * `@yourcrm/database`. It depends on these structural ports instead; the
 * API layer adapts the drizzle repository (`reports-repository.ts`) and
 * `writeAudit` to them, and the hermetic test fakes satisfy them the same
 * way.
 *
 * A report is a saved *definition* plus an *execution path*: CRUD moves the
 * definition around, `run` compiles and executes it. Execution results are
 * always filtered by the caller's permissions — see `access.ts`.
 */

/**
 * Filter tree in the encoding exported by `@yourcrm/ui`'s FilterBuilder
 * (`FilterTree`). There is exactly ONE filter model in the product; the
 * domain layer may not import UI, so the shape is restated here and in
 * `@yourcrm/database`'s `schema/reports.ts`. Keep the three in step —
 * never introduce a second model.
 */
export type ReportFilterCondition = {
  type: "condition"
  id: string
  field: string
  operator: string
  value?: unknown
}

export type ReportFilterGroup = {
  type: "group"
  id: string
  combinator: "and" | "or"
  children: ReportFilterNode[]
}

export type ReportFilterNode = ReportFilterCondition | ReportFilterGroup

export type ReportFilterTree = ReportFilterGroup

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type ReportRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
}

/**
 * Row visibility for one execution, derived from the caller's permissions
 * by `resolveReportRowScope` and never accepted from request input.
 */
export type ReportRowScope = { kind: "workspace" } | { kind: "own"; actorId: string }

/** Which saved definitions a caller may see in a list. */
export type ReportListScope = { kind: "all" } | { kind: "visible"; actorId: string }

export type ReportResultColumn = {
  key: string
  field: string | null
  label: string
  type: string
  role: "dimension" | "metric"
}

export type ReportExecutionResult = {
  objectType: string
  mode: "table" | "grouped"
  scope: ReportRowScope["kind"]
  columns: ReportResultColumn[]
  rows: Record<string, unknown>[]
  rowCount: number
  limit: number
  truncated: boolean
}

/** Serialisable field catalogue that drives the web report builder. */
export type ReportObjectCatalogEntry = {
  objectType: string
  label: string
  fields: { name: string; label: string; type: string; options?: string[] }[]
}

export type ReportListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
  objectType?: string
  visibility?: string
}

export type ReportListResult = {
  data: ReportRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type ReportExecutionRequest = {
  objectType: string
  filter?: ReportFilterTree | null
  groupBy?: string | null
  aggregations?: { fn: string; field?: string | null; label?: string | null }[] | null
  columns?: { field: string; label?: string | null }[] | null
  sort?: { field: string; direction: "asc" | "desc" }[] | null
  limit?: number | null
}

export type ReportsStore = {
  list(
    workspaceId: string,
    query: ReportListQuery,
    scope: ReportListScope,
  ): Promise<ReportListResult>
  findById(workspaceId: string, id: string): Promise<ReportRecord | null>
  create(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<ReportRecord>
  update(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<ReportRecord | null>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  restore(workspaceId: string, id: string): Promise<void>
  /** Compile and run a definition under `scope`. Rows never escape it. */
  execute(
    workspaceId: string,
    request: ReportExecutionRequest,
    scope: ReportRowScope,
  ): Promise<ReportExecutionResult>
  markRun(workspaceId: string, id: string, actorId?: string): Promise<void>
  describeObjects(): ReportObjectCatalogEntry[]
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type ReportAuditInput = {
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

export type ReportsServiceContext = ServiceContext

export type ReportsServiceDeps = {
  store: ReportsStore
  audit: AuditWriter<ReportAuditInput>
  events?: EventEmitter
}
