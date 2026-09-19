import { and, count, eq, isNull } from "drizzle-orm"
import type { Database } from "../client"
import { deals } from "../schema/deals"
import { memberships, workspaces } from "../schema/core"
import { onboardingProgress, type OnboardingProgressRow } from "../schema/onboarding"
import { people } from "../schema/people"
import { pipelines } from "../schema/pipelines"
import type { BaseTable } from "./base-repository"

/**
 * Real, read-only signals the onboarding checklist derives step completion
 * from. Every field here is a live query against another module's table —
 * never a value a caller can pass in. See `packages/crm/src/onboarding`.
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

function toSampleData(value: unknown): SampleDataRecord[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (v): v is SampleDataRecord =>
      typeof v === "object" &&
      v !== null &&
      typeof (v as { module?: unknown }).module === "string" &&
      typeof (v as { recordId?: unknown }).recordId === "string",
  )
}

function toStepCompletedAt(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v
  }
  return out
}

/**
 * Workspace-scoped onboarding repository: read-only signal aggregation
 * across foundation + module tables, plus persistence for the single
 * `onboarding_progress` row per workspace.
 */
export function createOnboardingRepository() {
  async function countTable(db: Database, table: BaseTable, workspaceId: string): Promise<number> {
    const rows = await db
      .select({ value: count() })
      .from(table)
      .where(and(eq(table.workspaceId, workspaceId), isNull(table.deletedAt)))
    return rows[0]?.value ?? 0
  }

  return {
    // Sequential (not Promise.all) on purpose: this runs once per checklist
    // view, not on a hot path, and sequential awaits keep the query order
    // deterministic and simple to test against a stubbed db.
    async getSignals(db: Database, workspaceId: string): Promise<OnboardingSignals> {
      const workspaceRows = await db
        .select({ timezone: workspaces.timezone, currency: workspaces.currency })
        .from(workspaces)
        .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
        .limit(1)
      const peopleCount = await countTable(db, people, workspaceId)
      const dealsCount = await countTable(db, deals, workspaceId)
      const pipelinesCount = await countTable(db, pipelines, workspaceId)
      const membershipRows = await db
        .select({ value: count() })
        .from(memberships)
        .where(and(eq(memberships.workspaceId, workspaceId), isNull(memberships.deletedAt)))
      return {
        workspaceTimezone: workspaceRows[0]?.timezone ?? "UTC",
        workspaceCurrency: workspaceRows[0]?.currency ?? "USD",
        peopleCount,
        dealsCount,
        pipelinesCount,
        membershipsCount: membershipRows[0]?.value ?? 0,
      }
    },

    async getByWorkspace(db: Database, workspaceId: string): Promise<OnboardingProgressRow | null> {
      const rows = await db
        .select()
        .from(onboardingProgress)
        .where(eq(onboardingProgress.workspaceId, workspaceId))
        .limit(1)
      return rows[0] ?? null
    },

    /** Idempotent: creates the one-per-workspace row on first access. */
    async getOrCreate(
      db: Database,
      workspaceId: string,
      actorId?: string,
    ): Promise<OnboardingProgressRow> {
      const existing = await this.getByWorkspace(db, workspaceId)
      if (existing) return existing
      const rows = await db
        .insert(onboardingProgress)
        .values({
          workspaceId,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .onConflictDoNothing({ target: onboardingProgress.workspaceId })
        .returning()
      if (rows[0]) return rows[0]
      // Lost the create race to a concurrent request: read the winner's row.
      const created = await this.getByWorkspace(db, workspaceId)
      if (!created) throw new Error("onboarding.getOrCreate: row missing after insert race")
      return created
    },

    /**
     * Server-derived write-through cache: only ever called by the domain
     * service *after* it has independently recomputed `done = true` from
     * `getSignals()`. Merges one key; never accepts a client-supplied map.
     */
    async markStepObservedDone(
      db: Database,
      workspaceId: string,
      stepKey: string,
      atIso: string,
    ): Promise<OnboardingProgressRow> {
      const row = await this.getOrCreate(db, workspaceId)
      const current = toStepCompletedAt(row.stepCompletedAt)
      if (current[stepKey]) return row
      const next = { ...current, [stepKey]: atIso }
      const updated = await db
        .update(onboardingProgress)
        .set({ stepCompletedAt: next, updatedAt: new Date() })
        .where(eq(onboardingProgress.workspaceId, workspaceId))
        .returning()
      return updated[0] ?? row
    },

    async setDismissed(
      db: Database,
      workspaceId: string,
      dismissed: boolean,
      actorId?: string,
    ): Promise<OnboardingProgressRow> {
      await this.getOrCreate(db, workspaceId, actorId)
      const updated = await db
        .update(onboardingProgress)
        .set({
          dismissedAt: dismissed ? new Date() : null,
          dismissedBy: dismissed ? (actorId ?? null) : null,
          updatedAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(eq(onboardingProgress.workspaceId, workspaceId))
        .returning()
      const row = updated[0]
      if (!row) throw new Error("onboarding.setDismissed: update returned no row")
      return row
    },

    async setSampleData(
      db: Database,
      workspaceId: string,
      records: SampleDataRecord[] | null,
      actorId?: string,
    ): Promise<OnboardingProgressRow> {
      await this.getOrCreate(db, workspaceId, actorId)
      const updated = await db
        .update(onboardingProgress)
        .set({
          sampleData: records ?? [],
          sampleDataSeededAt: records && records.length > 0 ? new Date() : null,
          sampleDataSeededBy: records && records.length > 0 ? (actorId ?? null) : null,
          updatedAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(eq(onboardingProgress.workspaceId, workspaceId))
        .returning()
      const row = updated[0]
      if (!row) throw new Error("onboarding.setSampleData: update returned no row")
      return row
    },
  }
}

export type OnboardingRepository = ReturnType<typeof createOnboardingRepository>

export function readStepCompletedAt(row: OnboardingProgressRow): Record<string, string> {
  return toStepCompletedAt(row.stepCompletedAt)
}

export function readSampleData(row: OnboardingProgressRow): SampleDataRecord[] {
  return toSampleData(row.sampleData)
}
