import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"

/**
 * Dashboards zod schemas. Services validate inputs with these; API routes
 * reuse them at the HTTP boundary via `@hono/zod-validator`.
 *
 * The widget type enum is intentionally re-declared here rather than
 * imported from `@yourcrm/database` (the database schema's `DASHBOARD_WIDGET_TYPES`) —
 * `@yourcrm/crm` never imports `@yourcrm/database` (same pattern as
 * `people`/`pipelines` re-declaring their small status enums).
 */

const nameSchema = z.string().trim().min(1).max(255)

export const widgetTypeSchema = z.enum(["metric", "table", "bar", "line"])

export type WidgetType = z.infer<typeof widgetTypeSchema>

const gridSizeSchema = z.number().int().min(1).max(12)
const gridPositionSchema = z.number().int().min(0)

export const dashboardWidgetInputSchema = z.object({
  type: widgetTypeSchema,
  title: z.string().trim().min(1).max(255),
  // Omitted -> the repository stacks the widget below the existing layout.
  positionX: gridPositionSchema.nullish(),
  positionY: gridPositionSchema.nullish(),
  width: gridSizeSchema.default(4),
  height: gridSizeSchema.default(2),
  // Opaque reference to a report owned by a different module — never
  // validated beyond "looks like an id" here.
  reportId: z.string().min(1).nullish(),
  config: z.record(z.string(), z.unknown()).nullish(),
})

export const createDashboardSchema = z.object({
  name: nameSchema,
  description: z.string().trim().max(10000).nullish(),
  ownerId: z.string().min(1).nullish(),
  widgets: z.array(dashboardWidgetInputSchema).max(50).default([]),
})

export type CreateDashboardInput = z.infer<typeof createDashboardSchema>

export const updateDashboardSchema = createDashboardSchema
  .omit({ widgets: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateDashboardInput = z.infer<typeof updateDashboardSchema>

export const createWidgetSchema = dashboardWidgetInputSchema

export type CreateWidgetInput = z.infer<typeof createWidgetSchema>

export const updateWidgetSchema = dashboardWidgetInputSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateWidgetInput = z.infer<typeof updateWidgetSchema>

export const repositionWidgetSchema = z.object({
  positionX: gridPositionSchema,
  positionY: gridPositionSchema,
  width: gridSizeSchema.nullish(),
  height: gridSizeSchema.nullish(),
})

export type RepositionWidgetInput = z.infer<typeof repositionWidgetSchema>

export const dashboardQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
})

export type DashboardQuery = z.infer<typeof dashboardQuerySchema>

export const dashboardSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type DashboardDto = z.infer<typeof dashboardSchema>

export const dashboardWidgetSchema = z.object({
  id: z.string(),
  dashboardId: z.string(),
  type: z.string(),
  title: z.string(),
  positionX: z.number(),
  positionY: z.number(),
  width: z.number(),
  height: z.number(),
  reportId: z.string().nullable().optional(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
})

export type DashboardWidgetDto = z.infer<typeof dashboardWidgetSchema>
