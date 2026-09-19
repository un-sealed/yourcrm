import { describe, expect, test } from "bun:test"
import { expectAllowed, expectDenied, makeServiceContext, makeSession } from "@yourcrm/testing"
import {
  createOnboardingService,
  NoSampleDataError,
  SampleDataUnavailableError,
  type OnboardingService,
} from "./index"
import type {
  OnboardingAuditInput,
  OnboardingProgressRecord,
  OnboardingSignals,
  OnboardingStore,
  SampleDataPort,
  SampleDataRecord,
} from "./types"

const BASE_SIGNALS: OnboardingSignals = {
  workspaceTimezone: "UTC",
  workspaceCurrency: "USD",
  peopleCount: 0,
  dealsCount: 0,
  pipelinesCount: 0,
  membershipsCount: 1,
}

/**
 * Hermetic fake store. `signals` stands in for the live people/deals/
 * pipelines/memberships/workspaces reads the real repository performs — a
 * test flips a count to simulate "a real deal was created" the same way the
 * production repository would observe one via SQL.
 */
function makeStore(initialSignals: Partial<OnboardingSignals> = {}) {
  const signals: OnboardingSignals = { ...BASE_SIGNALS, ...initialSignals }
  let row: OnboardingProgressRecord = {
    id: "prog_1",
    workspaceId: "",
    dismissedAt: null,
    dismissedBy: null,
    stepCompletedAt: {},
    sampleData: [],
    sampleDataSeededAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const store: OnboardingStore = {
    getSignals: async () => ({ ...signals }),
    getOrCreateProgress: async (workspaceId) => {
      row = { ...row, workspaceId: row.workspaceId || workspaceId }
      return row
    },
    markStepObservedDone: async (_workspaceId, stepKey, atIso) => {
      if (!row.stepCompletedAt[stepKey]) {
        row = { ...row, stepCompletedAt: { ...row.stepCompletedAt, [stepKey]: atIso } }
      }
      return row
    },
    setDismissed: async (_workspaceId, dismissed, actorId) => {
      row = {
        ...row,
        dismissedAt: dismissed ? new Date().toISOString() : null,
        dismissedBy: dismissed ? (actorId ?? null) : null,
      }
      return row
    },
    setSampleData: async (_workspaceId, records, _actorId) => {
      row = {
        ...row,
        sampleData: records ?? [],
        sampleDataSeededAt: records && records.length > 0 ? new Date().toISOString() : null,
      }
      return row
    },
  }
  return {
    signals,
    store,
    /** Test-only backdoor simulating a tampered/forged cache row. */
    forgeStepCompletedAt(stepKey: string, atIso: string) {
      row = { ...row, stepCompletedAt: { ...row.stepCompletedAt, [stepKey]: atIso } }
    },
    setSignal<K extends keyof OnboardingSignals>(key: K, value: OnboardingSignals[K]) {
      signals[key] = value
    },
    get row() {
      return row
    },
  }
}

function setup(
  role: "owner" | "admin" | "member" | "viewer" = "owner",
  signals: Partial<OnboardingSignals> = {},
  sampleData?: SampleDataPort,
) {
  const session = makeSession({ role })
  const ctx = makeServiceContext({ session })
  const audits: OnboardingAuditInput[] = []
  const backing = makeStore(signals)
  const service = createOnboardingService({
    store: backing.store,
    audit: async (input) => void audits.push(input),
    ...(sampleData ? { sampleData } : {}),
  })
  return { ctx, service, audits, backing }
}

describe("onboarding/service", () => {
  test("fresh workspace: every step is incomplete, 0%", async () => {
    const { ctx, service } = setup()
    const progress = await expectAllowed(() => service.getProgress(ctx))
    expect(progress.totalSteps).toBe(5)
    expect(progress.completedSteps).toBe(0)
    expect(progress.percentComplete).toBe(0)
    expect(progress.steps.every((s) => !s.done && s.completedAt === null)).toBe(true)
    expect(progress.dismissed).toBe(false)
    expect(progress.sampleDataSeeded).toBe(false)
  })

  test("first_deal flips to done only once a real deal exists, and records when", async () => {
    const { ctx, service, backing } = setup()
    const before = await expectAllowed(() => service.getProgress(ctx))
    expect(before.steps.find((s) => s.key === "first_deal")?.done).toBe(false)

    backing.setSignal("dealsCount", 1)
    const after = await expectAllowed(() => service.getProgress(ctx))
    const step = after.steps.find((s) => s.key === "first_deal")
    expect(step?.done).toBe(true)
    expect(step?.completedAt).not.toBeNull()
    expect(after.completedSteps).toBe(1)
    expect(after.percentComplete).toBe(20)
  })

  test("workspace_profile, pipeline_configured and teammate_invited derive from their own signals", async () => {
    const { ctx, service, backing } = setup()
    backing.setSignal("workspaceTimezone", "America/New_York")
    backing.setSignal("pipelinesCount", 1)
    backing.setSignal("membershipsCount", 2)
    const progress = await expectAllowed(() => service.getProgress(ctx))
    expect(progress.steps.find((s) => s.key === "workspace_profile")?.done).toBe(true)
    expect(progress.steps.find((s) => s.key === "pipeline_configured")?.done).toBe(true)
    expect(progress.steps.find((s) => s.key === "teammate_invited")?.done).toBe(true)
    expect(progress.steps.find((s) => s.key === "first_contact")?.done).toBe(false)
  })

  // --- Correctness property 1: completion is derived, never asserted. ---
  describe("forged completion is rejected", () => {
    test("a tampered step_completed_at cache does not mark a step done without real data", async () => {
      const { ctx, service, backing } = setup()
      // Simulate a forged/compromised cache row claiming `first_deal` is
      // already done, even though `dealsCount` is still 0 — this is exactly
      // the shape of a forged "step complete" write a malicious client (or
      // a corrupted cache) could produce if the service ever trusted it.
      backing.forgeStepCompletedAt("first_deal", new Date().toISOString())
      expect(backing.row.stepCompletedAt.first_deal).toBeDefined()

      const progress = await expectAllowed(() => service.getProgress(ctx))
      const step = progress.steps.find((s) => s.key === "first_deal")
      // The cache entry exists, but `done` is still recomputed from real
      // signals (dealsCount === 0), so it must read false.
      expect(step?.done).toBe(false)
      expect(progress.completedSteps).toBe(0)

      // Once a real deal exists, the same forged (now-stale) cache entry no
      // longer matters — the server observed it done and keeps its own
      // (earlier, forged) timestamp only as history; the source of truth
      // for `done` was, and remains, the live signal.
      backing.setSignal("dealsCount", 1)
      const after = await expectAllowed(() => service.getProgress(ctx))
      expect(after.steps.find((s) => s.key === "first_deal")?.done).toBe(true)
    })

    test("the service API has no parameter through which a step's done state can be supplied", () => {
      // Type-level guarantee: getProgress/dismiss/reopen take only a
      // ServiceContext. There is no request shape anywhere in this module
      // that carries a step key + done boolean from a caller into the
      // store. (Compile-time check — see also the API route's `.strict()`
      // zod schemas in schemas.ts.)
      const service: OnboardingService = setup().service
      expect(service.getProgress.length).toBe(1)
    })
  })

  describe("dismiss / reopen", () => {
    test("owner can dismiss and reopen; dismissedAt round-trips", async () => {
      const { ctx, service, audits } = setup("owner")
      const dismissed = await expectAllowed(() => service.dismiss(ctx))
      expect(dismissed.dismissed).toBe(true)
      expect(dismissed.dismissedAt).not.toBeNull()
      expect(audits.at(-1)).toMatchObject({ action: "dismiss", object: "onboarding" })

      const reopened = await expectAllowed(() => service.reopen(ctx))
      expect(reopened.dismissed).toBe(false)
      expect(reopened.dismissedAt).toBeNull()
      expect(audits.at(-1)).toMatchObject({ action: "reopen", object: "onboarding" })
    })

    test("member and viewer cannot dismiss (owner/admin only)", async () => {
      const member = setup("member")
      await expectDenied(() => member.service.dismiss(member.ctx))
      const viewer = setup("viewer")
      await expectDenied(() => viewer.service.dismiss(viewer.ctx))
    })

    test("viewer can still read progress", async () => {
      const { ctx, service } = setup("viewer")
      await expectAllowed(() => service.getProgress(ctx))
    })
  })

  describe("sample data", () => {
    function fakeSampleData(): { port: SampleDataPort; seeded: SampleDataRecord[] } {
      const seeded: SampleDataRecord[] = [
        { module: "person", recordId: "person_1" },
        { module: "deal", recordId: "deal_1" },
      ]
      const port: SampleDataPort = {
        seed: async () => seeded,
        remove: async () => undefined,
      }
      return { port, seeded }
    }

    test("seeding without a wired sampleData port fails loudly (reported as a blocker, not silently skipped)", async () => {
      const { ctx, service } = setup("owner")
      await expect(service.seedSampleData(ctx)).rejects.toBeInstanceOf(SampleDataUnavailableError)
    })

    test("owner can seed and later remove sample data; ids are tracked for removal", async () => {
      const { port, seeded } = fakeSampleData()
      const { ctx, service, audits, backing } = setup("owner", {}, port)
      const progress = await expectAllowed(() => service.seedSampleData(ctx))
      expect(progress.sampleDataSeeded).toBe(true)
      expect(backing.row.sampleData).toEqual(seeded)
      expect(audits.at(-1)).toMatchObject({ action: "seed_sample_data" })

      const after = await expectAllowed(() => service.removeSampleData(ctx))
      expect(after.sampleDataSeeded).toBe(false)
      expect(backing.row.sampleData).toEqual([])
      expect(audits.at(-1)).toMatchObject({ action: "remove_sample_data" })
    })

    test("removing sample data when none exists is NOT_FOUND", async () => {
      const { port } = fakeSampleData()
      const { ctx, service } = setup("owner", {}, port)
      await expect(service.removeSampleData(ctx)).rejects.toBeInstanceOf(NoSampleDataError)
    })

    test("member cannot seed sample data (owner/admin only)", async () => {
      const { port } = fakeSampleData()
      const { ctx, service } = setup("member", {}, port)
      await expectDenied(() => service.seedSampleData(ctx))
    })
  })
})
