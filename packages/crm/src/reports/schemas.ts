import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"
import type { ReportFilterNode, ReportFilterTree } from "./types"

/**
 * Reports zod schemas. Services validate inputs with these; API routes
 * reuse them at the HTTP boundary via `@hono/zod-validator`.
 *
 * Field names and object types are validated for *shape* here and for
 * *existence* against the schema-derived allowlist in the repository
 * (`resolveReportObject` / `resolveReportField`). Both gates run before any
 * SQL is built.
 */

const identifierSchema = z.string().trim().min(1).max(128)

/** Operators of `@yourcrm/ui`'s FilterBuilder — the single filter model. */
export const reportFilterOperators = [
  "eq",
  "neq",
  "contains",
  "startsWith",
  "endsWith",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "notIn",
  "isEmpty",
  "isNotEmpty",
  "between",
] as const

export const reportFilterOperatorSchema = z.enum(reportFilterOperators)

const reportFilterConditionSchema = z.object({
  type: z.literal("condition"),
  id: z.string().min(1).max(64),
  field: identifierSchema,
  operator: reportFilterOperatorSchema,
  value: z.unknown().optional(),
})

const reportFilterNodeSchema: z.ZodType<ReportFilterNode> = z.lazy(() =>
  z.union([reportFilterConditionSchema, reportFilterGroupSchema]),
)

const reportFilterGroupSchema: z.ZodType<ReportFilterTree> = z.lazy(() =>
  z.object({
    type: z.literal("group"),
    id: z.string().min(1).max(64),
    combinator: z.enum(["and", "or"]),
    children: z.array(reportFilterNodeSchema).max(50),
  }),
)

/** Root of a stored filter is always a group (empty group = match all). */
export const reportFilterTreeSchema = reportFilterGroupSchema

export const reportAggregateFunctions = ["count", "sum", "avg", "min", "max"] as const

export const reportAggregationSchema = z.object({
  fn: z.enum(reportAggregateFunctions),
  field: identifierSchema.nullish(),
  label: z.string().trim().max(128).nullish(),
})

export const reportColumnsSchema = z
  .array(z.object({ field: identifierSchema, label: z.string().trim().max(128).nullish() }))
  .max(25)

export const reportSortSchema = z
  .array(z.object({ field: identifierSchema, direction: z.enum(["asc", "desc"]) }))
  .max(5)

export const REPORT_MAX_ROWS = 500

export const createReportSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2000).nullish(),
  objectType: z.string().trim().min(1).max(64),
  visibility: z.enum(["private", "shared"]).nullish(),
  ownerId: z.string().min(1).nullish(),
  filter: reportFilterTreeSchema.nullish(),
  groupBy: identifierSchema.nullish(),
  aggregations: z.array(reportAggregationSchema).max(10).nullish(),
  columns: reportColumnsSchema.nullish(),
  sort: reportSortSchema.nullish(),
  rowLimit: z.number().int().min(1).max(REPORT_MAX_ROWS).nullish(),
})

export type CreateReportInput = z.infer<typeof createReportSchema>

export const updateReportSchema = createReportSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateReportInput = z.infer<typeof updateReportSchema>

export const reportQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
  objectType: z.string().trim().max(64).optional(),
  visibility: z.enum(["private", "shared"]).optional(),
})

export type ReportQuery = z.infer<typeof reportQuerySchema>

/**
 * Run-time overrides. Deliberately tiny: a run may narrow the row limit,
 * never widen the definition's reach (object, filters and columns come
 * from the saved report, which was validated when it was saved).
 */
export const runReportSchema = z.object({
  limit: z.number().int().min(1).max(REPORT_MAX_ROWS).optional(),
})

export type RunReportInput = z.infer<typeof runReportSchema>

export const reportSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  objectType: z.string(),
  visibility: z.string(),
  ownerId: z.string().nullable().optional(),
  filter: z.unknown().nullable().optional(),
  groupBy: z.string().nullable().optional(),
  aggregations: z.unknown().nullable().optional(),
  columns: z.unknown().nullable().optional(),
  sort: z.unknown().nullable().optional(),
  rowLimit: z.number(),
  lastRunAt: z.unknown(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type ReportDto = z.infer<typeof reportSchema>

export const reportResultSchema = z.object({
  objectType: z.string(),
  mode: z.enum(["table", "grouped"]),
  scope: z.enum(["workspace", "own"]),
  columns: z.array(
    z.object({
      key: z.string(),
      field: z.string().nullable(),
      label: z.string(),
      type: z.string(),
      role: z.enum(["dimension", "metric"]),
    }),
  ),
  rows: z.array(z.record(z.unknown())),
  rowCount: z.number(),
  limit: z.number(),
  truncated: z.boolean(),
})
