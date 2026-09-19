import { paginationQuerySchema } from "@yourcrm/validation"
import { z } from "zod"

/**
 * Customer Success zod schemas. The service validates inputs with these;
 * API routes reuse them at the HTTP boundary via `@hono/zod-validator`.
 *
 * Enum literals are restated here rather than imported from
 * `@yourcrm/database` — `@yourcrm/crm` has no database dependency, and
 * every reference module (people, tasks) does the same thing.
 */

const CS_LIFECYCLE_STAGES = ["onboarding", "adopting", "healthy", "at_risk", "churned"] as const
const CS_RENEWAL_STATUSES = ["open", "won", "lost"] as const

const dateInputSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !Number.isNaN(new Date(value).getTime()), { message: "must be a valid date" })

export const csLifecycleStageSchema = z.enum(CS_LIFECYCLE_STAGES)
export const csRenewalStatusSchema = z.enum(CS_RENEWAL_STATUSES)

export const createCsAccountSchema = z.object({
  companyId: z.string().min(1),
  ownerId: z.string().min(1).nullish(),
  lifecycleStage: csLifecycleStageSchema.nullish(),
  arr: z.number().nonnegative().nullish(),
  renewalDate: dateInputSchema.nullish(),
  notes: z.string().max(10000).nullish(),
})

export type CreateCsAccountInput = z.infer<typeof createCsAccountSchema>

export const updateCsAccountSchema = createCsAccountSchema
  .omit({ companyId: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateCsAccountInput = z.infer<typeof updateCsAccountSchema>

export const csAccountQuerySchema = paginationQuerySchema.extend({
  lifecycleStage: csLifecycleStageSchema.optional(),
})

export type CsAccountQuery = z.infer<typeof csAccountQuerySchema>

export const csHealthFactorSchema = z.object({
  key: z.string(),
  label: z.string(),
  rawValue: z.number().nullable(),
  normalizedScore: z.number(),
  weight: z.number(),
  contribution: z.number(),
})

export const csAccountSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  companyId: z.string(),
  ownerId: z.string().nullable().optional(),
  lifecycleStage: z.string(),
  arr: z.unknown().nullable().optional(),
  renewalDate: z.unknown().nullable().optional(),
  notes: z.string().nullable().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type CsAccountDto = z.infer<typeof csAccountSchema>

export const csHealthScoreSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  accountId: z.string(),
  score: z.unknown(),
  factors: z.array(csHealthFactorSchema),
  computedAt: z.unknown(),
  computedBy: z.string().nullable().optional(),
})

export type CsHealthScoreDto = z.infer<typeof csHealthScoreSchema>

export const createCsRenewalSchema = z.object({
  accountId: z.string().min(1),
  renewalDate: dateInputSchema,
  arr: z.number().nonnegative().nullish(),
  ownerId: z.string().min(1).nullish(),
  status: csRenewalStatusSchema.nullish(),
  riskFlag: z.boolean().nullish(),
  notes: z.string().max(10000).nullish(),
})

export type CreateCsRenewalInput = z.infer<typeof createCsRenewalSchema>

export const updateCsRenewalSchema = createCsRenewalSchema
  .omit({ accountId: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateCsRenewalInput = z.infer<typeof updateCsRenewalSchema>

export const csRenewalQuerySchema = paginationQuerySchema.extend({
  accountId: z.string().min(1).optional(),
  status: csRenewalStatusSchema.optional(),
  riskFlag: z.coerce.boolean().optional(),
  withinDays: z.coerce.number().int().positive().max(365).optional(),
})

export type CsRenewalQuery = z.infer<typeof csRenewalQuerySchema>

export const csRenewalSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  accountId: z.string(),
  renewalDate: z.unknown(),
  arr: z.unknown().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  status: z.string(),
  riskFlag: z.boolean(),
  notes: z.string().nullable().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type CsRenewalDto = z.infer<typeof csRenewalSchema>

export const applyCsPlaybookSchema = z.object({
  playbookKey: z.string().trim().min(1).max(64),
})

export type ApplyCsPlaybookInput = z.infer<typeof applyCsPlaybookSchema>

export const csPlaybookCatalogEntrySchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  taskCount: z.number(),
})

export const csPlaybookTaskSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  accountId: z.string(),
  playbookKey: z.string(),
  taskId: z.string(),
  appliedBy: z.string().nullable().optional(),
  appliedAt: z.unknown(),
})

export type CsPlaybookTaskDto = z.infer<typeof csPlaybookTaskSchema>
