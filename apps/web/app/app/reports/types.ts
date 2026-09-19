import type { FilterFieldDef, FilterFieldType, FilterTree } from "@yourcrm/ui"

/** Report definition as returned by `GET /api/v1/reports` (envelope `data`). */
export type Report = {
  id: string
  workspaceId: string
  name: string
  description: string | null
  objectType: string
  visibility: string
  ownerId: string | null
  filter: FilterTree | null
  groupBy: string | null
  aggregations: ReportAggregation[] | null
  columns: ReportColumn[] | null
  sort: ReportSort[] | null
  rowLimit: number
  lastRunAt: string | null
  createdAt: string
  updatedAt: string
}

export type ReportAggregateFunction = "count" | "sum" | "avg" | "min" | "max"

export type ReportAggregation = {
  fn: ReportAggregateFunction
  field?: string | null
  label?: string | null
}

export type ReportColumn = { field: string; label?: string | null }

export type ReportSort = { field: string; direction: "asc" | "desc" }

export type ReportsListResponse = {
  data: Report[]
  pagination: { nextCursor: string | null; limit: number }
}

/** One reportable object plus its allowlisted fields (`/reports/objects`). */
export type ReportObjectCatalogEntry = {
  objectType: string
  label: string
  fields: { name: string; label: string; type: string; options?: string[] }[]
}

export type ReportResultColumn = {
  key: string
  field: string | null
  label: string
  type: string
  role: "dimension" | "metric"
}

export type ReportResult = {
  objectType: string
  mode: "table" | "grouped"
  /** Which rows the server let this actor see. */
  scope: "workspace" | "own"
  columns: ReportResultColumn[]
  rows: Record<string, unknown>[]
  rowCount: number
  limit: number
  truncated: boolean
}

export const AGGREGATE_OPTIONS: { value: ReportAggregateFunction; label: string }[] = [
  { value: "count", label: "Count" },
  { value: "sum", label: "Sum" },
  { value: "avg", label: "Average" },
  { value: "min", label: "Minimum" },
  { value: "max", label: "Maximum" },
]

export const VISIBILITY_OPTIONS = [
  { value: "shared", label: "Shared with the workspace" },
  { value: "private", label: "Private to me" },
]

const FILTER_FIELD_TYPES: FilterFieldType[] = ["text", "number", "date", "boolean", "select"]

function toFilterFieldType(type: string): FilterFieldType {
  return (FILTER_FIELD_TYPES as string[]).includes(type) ? (type as FilterFieldType) : "text"
}

/**
 * Adapt the server field catalogue to the shared `FilterBuilder` contract.
 * The builder's `FilterTree` is the only filter model in the product — the
 * API stores and executes exactly what this component produces.
 */
export function toFilterFields(entry: ReportObjectCatalogEntry | undefined): FilterFieldDef[] {
  if (!entry) return []
  return entry.fields.map((field) => {
    const type = toFilterFieldType(field.type)
    const base: FilterFieldDef = { name: field.name, label: field.label, type }
    if (type === "select" && field.options) {
      return { ...base, options: field.options.map((value) => ({ value, label: value })) }
    }
    return base
  })
}

/** Field options for the grouping / aggregation / column selects. */
export function toFieldOptions(
  entry: ReportObjectCatalogEntry | undefined,
  predicate: (type: string) => boolean = () => true,
): { value: string; label: string }[] {
  if (!entry) return []
  return entry.fields
    .filter((field) => predicate(field.type))
    .map((field) => ({ value: field.name, label: field.label }))
}

/** Human summary of a definition, used on list rows and the detail header. */
export function describeReport(
  report: Pick<Report, "objectType" | "groupBy" | "aggregations">,
  catalogue: ReportObjectCatalogEntry[] = [],
): string {
  const entry = catalogue.find((o) => o.objectType === report.objectType)
  const objectLabel = entry?.label ?? report.objectType
  const metrics = report.aggregations ?? []
  const metricText =
    metrics.length === 0
      ? "All records"
      : metrics
          .map((metric) => {
            const fieldLabel =
              entry?.fields.find((f) => f.name === metric.field)?.label ?? metric.field
            return metric.fn === "count" && !metric.field
              ? "Count"
              : `${metric.fn.toUpperCase()} of ${String(fieldLabel)}`
          })
          .join(", ")
  const groupLabel =
    report.groupBy === null || report.groupBy === undefined
      ? null
      : (entry?.fields.find((f) => f.name === report.groupBy)?.label ?? report.groupBy)
  return groupLabel === null
    ? `${metricText} — ${objectLabel}`
    : `${metricText} — ${objectLabel} by ${groupLabel}`
}

/** Render a result cell defensively: the engine returns raw SQL values. */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  return JSON.stringify(value)
}
