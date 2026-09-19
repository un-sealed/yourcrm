import { z } from "zod"

/**
 * Import / Export background job (spec 30-import-export, P0 CSV only).
 *
 * Large imports/exports run as BullMQ jobs: the API records the job row,
 * enqueues this payload, and the worker validates + counts rows, then the
 * API's `/complete` endpoint closes the row. Registration in `worker.ts`
 * (`JobHandlers`) is left to the integrator — this file only defines the
 * validated input schema and the pure handler.
 */

export const importJobPayloadSchema = z.object({
  jobId: z.string().min(1).max(255),
  workspaceId: z.string().min(1).max(255),
  objectType: z.string().trim().min(1).max(64),
  mode: z.enum(["create", "update", "upsert"]).default("create"),
  mapping: z.record(z.string().trim().min(1).max(255), z.string().trim().min(1).max(255)),
  csvText: z.string().min(1).max(10_000_000),
  correlationId: z.string().optional(),
})

export type ImportJobPayload = z.infer<typeof importJobPayloadSchema>

export const exportJobPayloadSchema = z.object({
  jobId: z.string().min(1).max(255),
  workspaceId: z.string().min(1).max(255),
  objectType: z.string().trim().min(1).max(64),
  filters: z.record(z.unknown()).optional(),
  correlationId: z.string().optional(),
})

export type ExportJobPayload = z.infer<typeof exportJobPayloadSchema>

export type ImportExecutionResult = {
  jobId: string
  totalRows: number
  succeededRows: number
  failedRows: number
  skippedRows: number
  errors: { row: number; message: string }[]
}

function splitCsvRows(csvText: string): string[][] {
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
    } else if (ch !== "\r") {
      field += ch
    }
  }
  row.push(field)
  rows.push(row)
  return rows.filter((r) => !(r.length === 1 && (r[0] ?? "").trim() === ""))
}

/**
 * Pure execution step: parse the CSV, check the mapping covers the headers,
 * count per-row outcomes. Idempotent (pure function of validated input),
 * retryable, observable via the returned result. Never throws on row data —
 * row failures land in `errors`, never as job failures.
 */
export async function runImportJob(input: ImportJobPayload): Promise<ImportExecutionResult> {
  const parsed = importJobPayloadSchema.parse(input)
  const start = Date.now()
  const data = splitCsvRows(parsed.csvText)
  const headers = (data[0] ?? []).map((h) => h.trim())
  const body = data.slice(1)
  const indexOf = new Map(headers.map((h, i) => [h, i] as [string, number]))
  const missing = Object.keys(parsed.mapping).filter((source) => !indexOf.has(source))
  const errors: ImportExecutionResult["errors"] = []
  let succeededRows = 0
  let failedRows = 0
  body.forEach((cells, i) => {
    const rowNumber = i + 1
    if (missing.length > 0) {
      if (errors.length < 500) {
        errors.push({ row: rowNumber, message: `missing columns: ${missing.join(", ")}` })
      }
      failedRows++
      return
    }
    const empty = Object.keys(parsed.mapping).some(
      (source) => ((cells[indexOf.get(source) ?? -1] ?? "").trim()) === "",
    )
    if (empty) {
      if (errors.length < 500) errors.push({ row: rowNumber, message: "empty mapped value" })
      failedRows++
    } else {
      succeededRows++
    }
  })
  const result: ImportExecutionResult = {
    jobId: parsed.jobId,
    totalRows: body.length,
    succeededRows,
    failedRows,
    skippedRows: 0,
    errors,
  }
  console.log(
    JSON.stringify({
      level: "info",
      msg: "import_job_executed",
      jobId: parsed.jobId,
      workspaceId: parsed.workspaceId,
      objectType: parsed.objectType,
      totalRows: result.totalRows,
      durationMs: Date.now() - start,
      ...(parsed.correlationId === undefined ? {} : { correlationId: parsed.correlationId }),
    }),
  )
  return result
}

export type ExportExecutionResult = {
  jobId: string
  objectType: string
  filters: Record<string, unknown>
}

/**
 * Pure export step: validate the request and echo the filter snapshot the
 * API used to scope rows to the caller's permissions. Row fetching stays in
 * the API/repository layer; the worker only proves the payload is valid and
 * observable.
 */
export async function runExportJob(input: ExportJobPayload): Promise<ExportExecutionResult> {
  const parsed = exportJobPayloadSchema.parse(input)
  const start = Date.now()
  const result: ExportExecutionResult = {
    jobId: parsed.jobId,
    objectType: parsed.objectType,
    filters: parsed.filters ?? {},
  }
  console.log(
    JSON.stringify({
      level: "info",
      msg: "export_job_executed",
      jobId: parsed.jobId,
      workspaceId: parsed.workspaceId,
      objectType: parsed.objectType,
      durationMs: Date.now() - start,
      ...(parsed.correlationId === undefined ? {} : { correlationId: parsed.correlationId }),
    }),
  )
  return result
}
