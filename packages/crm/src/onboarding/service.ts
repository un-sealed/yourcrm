import { requirePermission } from "@yourcrm/permissions"
import { ONBOARDING_STEP_KEYS, type OnboardingStepKey } from "./schemas"
import type {
  OnboardingProgressRecord,
  OnboardingServiceContext,
  OnboardingServiceDeps,
  OnboardingSignals,
  SampleDataRecord,
} from "./types"

export class SampleDataUnavailableError extends Error {
  readonly code = "NOT_IMPLEMENTED"
  constructor() {
    super("Sample-data seeding is not wired up in this environment")
    this.name = "SampleDataUnavailableError"
  }
}

export class NoSampleDataError extends Error {
  readonly code = "NOT_FOUND"
  constructor() {
    super("No sample data has been seeded for this workspace")
    this.name = "NoSampleDataError"
  }
}

function permissionOf(ctx: OnboardingServiceContext, object: string, action: "read" | "admin") {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object,
    action,
  }
}

export type OnboardingStepDefinition = {
  key: OnboardingStepKey
  title: string
  description: string
  /** Pure function of real signals — never of anything a caller supplies. */
  isDone: (signals: OnboardingSignals) => boolean
}

/**
 * The checklist. Every step detects its own completion from real data
 * (see `OnboardingSignals`, sourced from `getSignals()` in the repository)
 * — there is no "mark this step done" input anywhere in this module.
 */
export const ONBOARDING_STEPS: readonly OnboardingStepDefinition[] = [
  {
    key: "workspace_profile",
    title: "Set your workspace timezone and currency",
    description: "Update timezone/currency in workspace settings so dates and amounts are right.",
    isDone: (s) => s.workspaceTimezone !== "UTC" || s.workspaceCurrency !== "USD",
  },
  {
    key: "first_contact",
    title: "Add your first contact",
    description: "Create a person (or import a CSV) so you have someone to work with.",
    isDone: (s) => s.peopleCount > 0,
  },
  {
    key: "first_deal",
    title: "Create your first deal",
    description: "Open a deal so you can track it through your pipeline.",
    isDone: (s) => s.dealsCount > 0,
  },
  {
    key: "pipeline_configured",
    title: "Set up a pipeline",
    description: "Configure the stages your deals move through.",
    isDone: (s) => s.pipelinesCount > 0,
  },
  {
    key: "teammate_invited",
    title: "Invite a teammate",
    description: "Bring a colleague into the workspace.",
    isDone: (s) => s.membershipsCount > 1,
  },
]

export type OnboardingStepResult = {
  key: OnboardingStepKey
  title: string
  description: string
  done: boolean
  completedAt: string | null
}

export type OnboardingProgressResult = {
  workspaceId: string
  steps: OnboardingStepResult[]
  completedSteps: number
  totalSteps: number
  percentComplete: number
  dismissed: boolean
  dismissedAt: string | null
  sampleDataSeeded: boolean
  sampleDataSeededAt: string | null
}

function toIso(value: unknown): string | null {
  if (!value) return null
  if (typeof value === "string") return value
  if (value instanceof Date) return value.toISOString()
  return null
}

/**
 * Onboarding domain service (spec 42-onboarding, P0).
 *
 * `getProgress` is the only place step completion is computed, and it is
 * ALWAYS computed from `store.getSignals()` — live reads of people/deals/
 * pipelines/memberships/workspaces. Nothing in this service accepts a
 * caller-supplied "step complete" flag (see correctness property 1 in the
 * module spec): a forged request has no field to carry that forgery in.
 */
export function createOnboardingService(deps: OnboardingServiceDeps) {
  async function computeProgress(
    ctx: OnboardingServiceContext,
    signals: OnboardingSignals,
    row: OnboardingProgressRecord,
  ): Promise<OnboardingProgressResult> {
    const steps: OnboardingStepResult[] = []
    for (const def of ONBOARDING_STEPS) {
      const done = def.isDone(signals)
      let completedAt = row.stepCompletedAt[def.key] ?? null
      if (done && !completedAt) {
        const nowIso = new Date().toISOString()
        const updated = await deps.store.markStepObservedDone(ctx.workspaceId, def.key, nowIso)
        completedAt = updated.stepCompletedAt[def.key] ?? nowIso
      }
      // `done` itself is NEVER read from the cache/row — only recomputed
      // above from `signals`. The cache only supplies the timestamp.
      steps.push({
        key: def.key,
        title: def.title,
        description: def.description,
        done,
        completedAt,
      })
    }
    const completedSteps = steps.filter((s) => s.done).length
    return {
      workspaceId: ctx.workspaceId,
      steps,
      completedSteps,
      totalSteps: steps.length,
      percentComplete: Math.round((completedSteps / steps.length) * 100),
      dismissed: row.dismissedAt !== null,
      dismissedAt: toIso(row.dismissedAt),
      sampleDataSeeded: row.sampleData.length > 0,
      sampleDataSeededAt: toIso(row.sampleDataSeededAt),
    }
  }

  async function getProgress(ctx: OnboardingServiceContext): Promise<OnboardingProgressResult> {
    requirePermission(permissionOf(ctx, "onboarding", "read"))
    // Respect the caller's permissions for each underlying object read
    // rather than bypassing requirePermission() to count records directly.
    requirePermission(permissionOf(ctx, "person", "read"))
    requirePermission(permissionOf(ctx, "deal", "read"))
    requirePermission(permissionOf(ctx, "pipeline", "read"))
    requirePermission(permissionOf(ctx, "workspace", "read"))
    requirePermission(permissionOf(ctx, "membership", "read"))
    const [signals, row] = await Promise.all([
      deps.store.getSignals(ctx.workspaceId),
      deps.store.getOrCreateProgress(ctx.workspaceId, ctx.actorId),
    ])
    return computeProgress(ctx, signals, row)
  }

  async function dismiss(ctx: OnboardingServiceContext): Promise<OnboardingProgressResult> {
    requirePermission(permissionOf(ctx, "onboarding", "admin"))
    const before = await deps.store.getOrCreateProgress(ctx.workspaceId, ctx.actorId)
    const after = await deps.store.setDismissed(ctx.workspaceId, true, ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "dismiss",
      object: "onboarding",
      recordId: after.id,
      before: { dismissedAt: before.dismissedAt },
      after: { dismissedAt: after.dismissedAt },
      correlationId: ctx.correlationId,
    })
    const signals = await deps.store.getSignals(ctx.workspaceId)
    return computeProgress(ctx, signals, after)
  }

  async function reopen(ctx: OnboardingServiceContext): Promise<OnboardingProgressResult> {
    requirePermission(permissionOf(ctx, "onboarding", "admin"))
    const before = await deps.store.getOrCreateProgress(ctx.workspaceId, ctx.actorId)
    const after = await deps.store.setDismissed(ctx.workspaceId, false, ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "reopen",
      object: "onboarding",
      recordId: after.id,
      before: { dismissedAt: before.dismissedAt },
      after: { dismissedAt: after.dismissedAt },
      correlationId: ctx.correlationId,
    })
    const signals = await deps.store.getSignals(ctx.workspaceId)
    return computeProgress(ctx, signals, after)
  }

  async function seedSampleData(ctx: OnboardingServiceContext): Promise<OnboardingProgressResult> {
    requirePermission(permissionOf(ctx, "onboarding", "admin"))
    if (!deps.sampleData) throw new SampleDataUnavailableError()
    const created: SampleDataRecord[] = await deps.sampleData.seed(ctx)
    const after = await deps.store.setSampleData(ctx.workspaceId, created, ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "seed_sample_data",
      object: "onboarding",
      recordId: after.id,
      after: { sampleData: created },
      correlationId: ctx.correlationId,
      source: "user",
    })
    const signals = await deps.store.getSignals(ctx.workspaceId)
    return computeProgress(ctx, signals, after)
  }

  async function removeSampleData(
    ctx: OnboardingServiceContext,
  ): Promise<OnboardingProgressResult> {
    requirePermission(permissionOf(ctx, "onboarding", "admin"))
    if (!deps.sampleData) throw new SampleDataUnavailableError()
    const before = await deps.store.getOrCreateProgress(ctx.workspaceId, ctx.actorId)
    if (before.sampleData.length === 0) throw new NoSampleDataError()
    await deps.sampleData.remove(ctx, before.sampleData)
    const after = await deps.store.setSampleData(ctx.workspaceId, [], ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "remove_sample_data",
      object: "onboarding",
      recordId: after.id,
      before: { sampleData: before.sampleData },
      after: { sampleData: [] },
      correlationId: ctx.correlationId,
      source: "user",
    })
    const signals = await deps.store.getSignals(ctx.workspaceId)
    return computeProgress(ctx, signals, after)
  }

  return { getProgress, dismiss, reopen, seedSampleData, removeSampleData }
}

export type OnboardingService = ReturnType<typeof createOnboardingService>

export { ONBOARDING_STEP_KEYS }
