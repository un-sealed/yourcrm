import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import { createOnboardingService, type OnboardingService } from "@yourcrm/crm/src/onboarding"
import type {
  OnboardingProgressRecord,
  OnboardingSignals,
  OnboardingStore,
  SampleDataPort,
  SampleDataRecord,
} from "@yourcrm/crm/src/onboarding"
import { createApiClient, makeSession } from "@yourcrm/testing"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes } from "./onboarding"

const BASE_SIGNALS: OnboardingSignals = {
  workspaceTimezone: "UTC",
  workspaceCurrency: "USD",
  peopleCount: 0,
  dealsCount: 0,
  pipelinesCount: 0,
  membershipsCount: 1,
}

/** Hermetic in-memory OnboardingStore, mirroring the crm package's fake. */
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
    setSampleData: async (_workspaceId, records) => {
      row = {
        ...row,
        sampleData: records ?? [],
        sampleDataSeededAt: records && records.length > 0 ? new Date().toISOString() : null,
      }
      return row
    },
  }
  return {
    store,
    setSignal: (k: keyof OnboardingSignals, v: number | string) => {
      ;(signals as unknown as Record<string, number | string>)[k] = v
    },
  }
}

function makeFakeSampleData(): SampleDataPort {
  const seeded: SampleDataRecord[] = [
    { module: "person", recordId: "person_1" },
    { module: "deal", recordId: "deal_1" },
  ]
  return {
    seed: async () => seeded,
    remove: async () => undefined,
  }
}

function makeTestApp(session: { current: Session | null }, service: OnboardingService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/onboarding", createRoutes({ service }))
  return app
}

describe("api/onboarding", () => {
  let session: { current: Session | null }

  beforeEach(() => {
    session = { current: makeSession({ role: "owner" }) }
  })

  test("unauthenticated requests get UNAUTHORIZED", async () => {
    session.current = null
    const service = createOnboardingService({
      store: makeStore().store,
      audit: async () => undefined,
    })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/onboarding/progress")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("progress returns the derived checklist envelope", async () => {
    const service = createOnboardingService({
      store: makeStore().store,
      audit: async () => undefined,
    })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/onboarding/progress")
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    const data = body.data as { steps: unknown[]; percentComplete: number }
    expect(data.steps).toHaveLength(5)
    expect(data.percentComplete).toBe(0)
  })

  test("a forged request body claiming a step is done is silently ignored: the route never reads the body", async () => {
    const service = createOnboardingService({
      store: makeStore().store,
      audit: async () => undefined,
    })
    const api = createApiClient({ app: makeTestApp(session, service) })
    // An attacker (or a buggy client) tries to assert completion directly.
    const res = await api.post("/api/v1/onboarding/dismiss", {
      steps: { first_deal: { done: true } },
      forceComplete: true,
    })
    expect(res.status).toBe(200)
    const dismissed = res.expectSuccess().data as { steps: { key: string; done: boolean }[] }
    // Dismissing succeeded (a legitimate action), but no step was marked
    // done by the forged payload — completion still requires real data.
    expect(dismissed.steps.find((s) => s.key === "first_deal")?.done).toBe(false)
  })

  test("viewer cannot dismiss (owner/admin only) — denial maps to 403", async () => {
    session.current = makeSession({ role: "viewer" })
    const service = createOnboardingService({
      store: makeStore().store,
      audit: async () => undefined,
    })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/onboarding/dismiss")
    expect(res.status).toBe(403)
    res.expectError("FORBIDDEN")
  })

  test("owner can dismiss then reopen", async () => {
    const service = createOnboardingService({
      store: makeStore().store,
      audit: async () => undefined,
    })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const dismissed = await api.post("/api/v1/onboarding/dismiss")
    expect(dismissed.status).toBe(200)
    expect((dismissed.expectSuccess().data as { dismissed: boolean }).dismissed).toBe(true)
    const reopened = await api.post("/api/v1/onboarding/reopen")
    expect(reopened.status).toBe(200)
    expect((reopened.expectSuccess().data as { dismissed: boolean }).dismissed).toBe(false)
  })

  test("seeding without a wired sample-data port returns NOT_IMPLEMENTED (501)", async () => {
    const service = createOnboardingService({
      store: makeStore().store,
      audit: async () => undefined,
    })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/onboarding/sample-data")
    expect(res.status).toBe(501)
    res.expectError("NOT_IMPLEMENTED")
  })

  test("seed then remove sample data round-trips", async () => {
    const service = createOnboardingService({
      store: makeStore().store,
      audit: async () => undefined,
      sampleData: makeFakeSampleData(),
    })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const seeded = await api.post("/api/v1/onboarding/sample-data")
    expect(seeded.status).toBe(201)
    expect((seeded.expectSuccess().data as { sampleDataSeeded: boolean }).sampleDataSeeded).toBe(
      true,
    )
    const removed = await api.delete("/api/v1/onboarding/sample-data")
    expect(removed.status).toBe(200)
    expect((removed.expectSuccess().data as { sampleDataSeeded: boolean }).sampleDataSeeded).toBe(
      false,
    )
  })

  test("removing sample data when none exists is NOT_FOUND", async () => {
    const service = createOnboardingService({
      store: makeStore().store,
      audit: async () => undefined,
      sampleData: makeFakeSampleData(),
    })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.delete("/api/v1/onboarding/sample-data")
    expect(res.status).toBe(404)
    res.expectError("NOT_FOUND")
  })
})
