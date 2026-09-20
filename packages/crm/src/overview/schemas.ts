import { z } from "zod"

/**
 * Overview zod schemas. `GET /api/v1/overview` takes no query params and no
 * body — there is nothing for a caller to assert (see `types.ts`), so these
 * only describe the response envelope, reused at the HTTP boundary the same
 * way `onboardingProgressSchema` is.
 */

export const overviewKpiSchema = z.object({
  value: z.number(),
  delta: z.number().nullable(),
  currency: z.string().optional(),
})

export type OverviewKpiDto = z.infer<typeof overviewKpiSchema>

export const overviewKpisSchema = z.object({
  openPipelineValue: overviewKpiSchema,
  dealsWonThisMonth: overviewKpiSchema,
  newContactsThisMonth: overviewKpiSchema,
  activitiesThisWeek: overviewKpiSchema,
})

export const overviewTrendPointSchema = z.object({
  date: z.string(),
  created: z.number().int(),
  won: z.number().int(),
})

export type OverviewTrendPointDto = z.infer<typeof overviewTrendPointSchema>

export const overviewActivityPointSchema = z.object({
  date: z.string(),
  label: z.string(),
  count: z.number().int(),
})

export type OverviewActivityPointDto = z.infer<typeof overviewActivityPointSchema>

export const overviewGoalSchema = z.object({
  attained: z.number().min(0).max(1),
  wonValue: z.number(),
  targetValue: z.number(),
})

export type OverviewGoalDto = z.infer<typeof overviewGoalSchema>

export const overviewRecentDealSchema = z.object({
  id: z.string(),
  name: z.string(),
  company: z.string().nullable(),
  amount: z.number().nullable(),
  currency: z.string(),
  stage: z.string(),
  updatedAt: z.string(),
})

export type OverviewRecentDealDto = z.infer<typeof overviewRecentDealSchema>

export const overviewSchema = z.object({
  kpis: overviewKpisSchema,
  trend: z.array(overviewTrendPointSchema),
  activityByDay: z.array(overviewActivityPointSchema),
  goal: overviewGoalSchema,
  recentDeals: z.array(overviewRecentDealSchema),
})

export type OverviewDto = z.infer<typeof overviewSchema>
