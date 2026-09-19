import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"
import type { MarketingFilterNode, MarketingFilterTree } from "./types"

/**
 * Marketing zod schemas. Services validate inputs with these; API routes
 * reuse them at the HTTP boundary via `@hono/zod-validator`.
 *
 * `marketingFilterTreeSchema` mirrors `@yourcrm/ui`'s FilterBuilder /
 * `reports/schemas.ts`'s `reportFilterTreeSchema` exactly (same operators,
 * same shape) — a segment's audience IS a saved filter over people.
 */

const identifierSchema = z.string().trim().min(1).max(128)

export const marketingFilterOperators = [
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

export const marketingFilterOperatorSchema = z.enum(marketingFilterOperators)

const marketingFilterConditionSchema = z.object({
  type: z.literal("condition"),
  id: z.string().min(1).max(64),
  field: identifierSchema,
  operator: marketingFilterOperatorSchema,
  value: z.unknown().optional(),
})

const marketingFilterNodeSchema: z.ZodType<MarketingFilterNode> = z.lazy(() =>
  z.union([marketingFilterConditionSchema, marketingFilterGroupSchema]),
)

const marketingFilterGroupSchema: z.ZodType<MarketingFilterTree> = z.lazy(() =>
  z.object({
    type: z.literal("group"),
    id: z.string().min(1).max(64),
    combinator: z.enum(["and", "or"]),
    children: z.array(marketingFilterNodeSchema).max(50),
  }),
)

/** Root of a stored segment filter is always a group (empty group = match all). */
export const marketingFilterTreeSchema = marketingFilterGroupSchema

/* ------------------------------- segments -------------------------------- */

export const createMarketingSegmentSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2000).nullish(),
  ownerId: z.string().min(1).nullish(),
  filter: marketingFilterTreeSchema,
})

export type CreateMarketingSegmentInput = z.infer<typeof createMarketingSegmentSchema>

export const updateMarketingSegmentSchema = createMarketingSegmentSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateMarketingSegmentInput = z.infer<typeof updateMarketingSegmentSchema>

export const marketingSegmentQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
})

export type MarketingSegmentQuery = z.infer<typeof marketingSegmentQuerySchema>

export const marketingSegmentSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  filter: z.unknown(),
  memberCount: z.number().nullable().optional(),
  lastEvaluatedAt: z.unknown(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type MarketingSegmentDto = z.infer<typeof marketingSegmentSchema>

/* ------------------------------- campaigns -------------------------------- */

export const createMarketingCampaignSchema = z.object({
  name: z.string().trim().min(1).max(255),
  subject: z.string().trim().min(1).max(998),
  bodyHtml: z.string().max(2_000_000).nullish(),
  bodyText: z.string().max(1_000_000).nullish(),
  segmentId: z.string().min(1),
  ownerId: z.string().min(1).nullish(),
  connectionId: z.string().min(1).nullish(),
})

export type CreateMarketingCampaignInput = z.infer<typeof createMarketingCampaignSchema>

export const updateMarketingCampaignSchema = createMarketingCampaignSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateMarketingCampaignInput = z.infer<typeof updateMarketingCampaignSchema>

export const marketingCampaignStatuses = [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "cancelled",
] as const

export const marketingCampaignQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
  status: z.enum(marketingCampaignStatuses).optional(),
})

export type MarketingCampaignQuery = z.infer<typeof marketingCampaignQuerySchema>

export const scheduleMarketingCampaignSchema = z.object({
  scheduledAt: z.coerce.date(),
})

export type ScheduleMarketingCampaignInput = z.infer<typeof scheduleMarketingCampaignSchema>

export const marketingCampaignSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  subject: z.string(),
  bodyHtml: z.string().nullable().optional(),
  bodyText: z.string().nullable().optional(),
  segmentId: z.string(),
  status: z.string(),
  scheduledAt: z.unknown(),
  sentAt: z.unknown(),
  connectionId: z.string().nullable().optional(),
  recipientCount: z.number(),
  sentCount: z.number(),
  failedCount: z.number(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type MarketingCampaignDto = z.infer<typeof marketingCampaignSchema>

/* -------------------------------- consent --------------------------------- */

export const upsertMarketingConsentSchema = z.object({
  personId: z.string().min(1),
  marketingConsent: z.boolean(),
  source: z.string().trim().max(32).optional(),
})

export type UpsertMarketingConsentInput = z.infer<typeof upsertMarketingConsentSchema>

export const unsubscribeByTokenSchema = z.object({
  token: z.string().min(1).max(64),
})

export type UnsubscribeByTokenInput = z.infer<typeof unsubscribeByTokenSchema>

export const marketingConsentSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  personId: z.string(),
  marketingConsent: z.boolean(),
  unsubscribedAt: z.unknown(),
  unsubscribeToken: z.string(),
  consentSource: z.string(),
})

export type MarketingConsentDto = z.infer<typeof marketingConsentSchema>
