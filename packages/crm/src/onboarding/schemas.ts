import { z } from "zod"

/**
 * Onboarding zod schemas. The service validates inputs with these; API
 * routes reuse them at the HTTP boundary via `@hono/zod-validator`.
 *
 * Every mutating onboarding endpoint (dismiss / reopen / seed sample data /
 * remove sample data) takes an EMPTY, `.strict()` body on purpose: there is
 * no field anywhere in this contract for a caller to assert "step X is
 * done". Completion is only ever computed server-side from real data (see
 * `service.ts`). `.strict()` means a request that tries to smuggle in e.g.
 * `{ steps: { firstDeal: true } }` is rejected as a 400 VALIDATION_ERROR
 * before it ever reaches the service.
 */
export const onboardingActionSchema = z.object({}).strict()

export type OnboardingActionInput = z.infer<typeof onboardingActionSchema>

export const ONBOARDING_STEP_KEYS = [
  "workspace_profile",
  "first_contact",
  "first_deal",
  "pipeline_configured",
  "teammate_invited",
] as const

export const onboardingStepKeySchema = z.enum(ONBOARDING_STEP_KEYS)

export type OnboardingStepKey = z.infer<typeof onboardingStepKeySchema>

export const onboardingStepSchema = z.object({
  key: onboardingStepKeySchema,
  title: z.string(),
  description: z.string(),
  done: z.boolean(),
  completedAt: z.string().nullable(),
})

export type OnboardingStepDto = z.infer<typeof onboardingStepSchema>

export const onboardingProgressSchema = z.object({
  workspaceId: z.string(),
  steps: z.array(onboardingStepSchema),
  completedSteps: z.number().int(),
  totalSteps: z.number().int(),
  percentComplete: z.number().int().min(0).max(100),
  dismissed: z.boolean(),
  dismissedAt: z.string().nullable(),
  sampleDataSeeded: z.boolean(),
  sampleDataSeededAt: z.string().nullable(),
})

export type OnboardingProgressDto = z.infer<typeof onboardingProgressSchema>
