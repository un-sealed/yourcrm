import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"

/**
 * Onboarding service ports (mirrors the people module pattern, see
 * `../ports.ts`). `@yourcrm/crm` has no database dependency, so the service
 * depends on these structural ports instead; the API layer adapts the
 * drizzle repository (`onboarding-repository.ts`) — and, for sample-data
 * seeding, the People/Deals/Pipelines domain services — to them.
 */

/**
 * Real signals the checklist derives step completion from. Every field is
 * a live read from another module's table (people/deals/pipelines) or a
 * foundation table (workspaces/memberships). This type has no room for a
 * client-supplied "done" flag — completion is always computed from these.
 */
export type OnboardingSignals = {
  workspaceTimezone: string
  workspaceCurrency: string
  peopleCount: number
  dealsCount: number
  pipelinesCount: number
  membershipsCount: number
}

export type SampleDataRecord = { module: string; recordId: string }

export type OnboardingProgressRecord = {
  id: string
  workspaceId: string
  dismissedAt: string | null
  dismissedBy: string | null
  /** Server-derived cache: step key -> ISO timestamp first observed done. */
  stepCompletedAt: Record<string, string>
  sampleData: SampleDataRecord[]
  sampleDataSeededAt: string | null
  createdAt: unknown
  updatedAt: unknown
}

export type OnboardingStore = {
  getSignals(workspaceId: string): Promise<OnboardingSignals>
  getOrCreateProgress(workspaceId: string, actorId?: string): Promise<OnboardingProgressRecord>
  /**
   * Write-through cache only: callers must have already independently
   * derived `done = true` from `getSignals()` before calling this. It never
   * takes a caller-supplied "is this step done" boolean.
   */
  markStepObservedDone(
    workspaceId: string,
    stepKey: string,
    atIso: string,
  ): Promise<OnboardingProgressRecord>
  setDismissed(
    workspaceId: string,
    dismissed: boolean,
    actorId?: string,
  ): Promise<OnboardingProgressRecord>
  setSampleData(
    workspaceId: string,
    records: SampleDataRecord[] | null,
    actorId?: string,
  ): Promise<OnboardingProgressRecord>
}

/**
 * Sample-data seeding port. Implemented in the API layer by composing the
 * People/Deals/Pipelines domain services (their own `create`/`softDelete`),
 * never by writing to their tables directly — onboarding does not own those
 * schemas. Optional: if not wired, seeding is reported as unavailable.
 */
export type SampleDataPort = {
  seed(ctx: OnboardingServiceContext): Promise<SampleDataRecord[]>
  remove(ctx: OnboardingServiceContext, records: SampleDataRecord[]): Promise<void>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type OnboardingAuditInput = {
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

export type OnboardingServiceContext = ServiceContext

export type OnboardingServiceDeps = {
  store: OnboardingStore
  audit: AuditWriter<OnboardingAuditInput>
  events?: EventEmitter
  sampleData?: SampleDataPort
}
