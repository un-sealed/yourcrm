import { describe, expect, test } from "bun:test"
import { expectAllowed, expectDenied, makeServiceContext } from "@yourcrm/testing"
import { createOverviewService } from "./index"
import type { OverviewSignals, OverviewStore } from "./types"

const BASE_SIGNALS: OverviewSignals = {
  workspaceCurrency: "USD",
  openPipelineValue: { value: 10000, priorValue: null },
  dealsWonThisMonth: { current: 3, prior: 1 },
  newContactsThisMonth: { current: 5, prior: 2 },
  activitiesThisWeek: { current: 8, prior: 8 },
  wonValueThisMonth: 4000,
  trend: [{ date: "2026-09-01", created: 1, won: 0 }],
  activityByDay: [{ date: "2026-09-20", label: "Sun", count: 2 }],
  recentDeals: [
    {
      id: "deal_1",
      name: "Acme renewal",
      company: "Acme Inc",
      amount: 4000,
      currency: "USD",
      stage: "won",
      updatedAt: "2026-09-20T00:00:00.000Z",
    },
  ],
}

function makeStore(overrides: Partial<OverviewSignals> = {}) {
  const signals: OverviewSignals = { ...BASE_SIGNALS, ...overrides }
  const calls: Array<{ workspaceId: string; now: Date }> = []
  const store: OverviewStore = {
    getOverview: async (workspaceId, now) => {
      calls.push({ workspaceId, now })
      return signals
    },
  }
  return { store, calls }
}

describe("overview/service", () => {
  test("computes KPI deltas from current/prior signal pairs", async () => {
    const { store } = makeStore()
    const service = createOverviewService({ store })
    const ctx = makeServiceContext({ role: "owner" })
    const result = await expectAllowed(() => service.getOverview(ctx))

    expect(result.kpis.dealsWonThisMonth).toEqual({ value: 3, delta: 2 })
    expect(result.kpis.newContactsThisMonth).toEqual({ value: 5, delta: 3 })
    expect(result.kpis.activitiesThisWeek).toEqual({ value: 8, delta: 0 })
  })

  test("openPipelineValue.delta is null when the repository has no prior snapshot", async () => {
    const { store } = makeStore({ openPipelineValue: { value: 10000, priorValue: null } })
    const service = createOverviewService({ store })
    const ctx = makeServiceContext({ role: "owner" })
    const result = await expectAllowed(() => service.getOverview(ctx))

    expect(result.kpis.openPipelineValue).toEqual({ value: 10000, delta: null, currency: "USD" })
  })

  test("openPipelineValue.delta is current minus prior when the repository does supply one", async () => {
    const { store } = makeStore({ openPipelineValue: { value: 10000, priorValue: 7500 } })
    const service = createOverviewService({ store })
    const ctx = makeServiceContext({ role: "owner" })
    const result = await expectAllowed(() => service.getOverview(ctx))

    expect(result.kpis.openPipelineValue.delta).toBe(2500)
  })

  test("goal.targetValue is open + won this month, and attained = won / target", async () => {
    const { store } = makeStore({
      openPipelineValue: { value: 6000, priorValue: null },
      wonValueThisMonth: 4000,
    })
    const service = createOverviewService({ store })
    const ctx = makeServiceContext({ role: "owner" })
    const result = await expectAllowed(() => service.getOverview(ctx))

    expect(result.goal).toEqual({ attained: 0.4, wonValue: 4000, targetValue: 10000 })
  })

  test("goal.attained is 0, not NaN, when there is no open or won value at all", async () => {
    const { store } = makeStore({
      openPipelineValue: { value: 0, priorValue: null },
      wonValueThisMonth: 0,
    })
    const service = createOverviewService({ store })
    const ctx = makeServiceContext({ role: "owner" })
    const result = await expectAllowed(() => service.getOverview(ctx))

    expect(result.goal).toEqual({ attained: 0, wonValue: 0, targetValue: 0 })
  })

  test("trend, activityByDay and recentDeals pass through from the store untouched", async () => {
    const { store } = makeStore()
    const service = createOverviewService({ store })
    const ctx = makeServiceContext({ role: "owner" })
    const result = await expectAllowed(() => service.getOverview(ctx))

    expect(result.trend).toEqual(BASE_SIGNALS.trend)
    expect(result.activityByDay).toEqual(BASE_SIGNALS.activityByDay)
    expect(result.recentDeals).toEqual(BASE_SIGNALS.recentDeals)
  })

  test("passes the injected clock through to the store for deterministic period boundaries", async () => {
    const { store, calls } = makeStore()
    const frozen = new Date("2026-09-20T12:00:00.000Z")
    const service = createOverviewService({ store, now: () => frozen })
    const ctx = makeServiceContext({ role: "owner", workspaceId: "ws_1" })
    await expectAllowed(() => service.getOverview(ctx))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.workspaceId).toBe("ws_1")
    expect(calls[0]?.now).toBe(frozen)
  })

  describe("permissions", () => {
    test("every workspace role can read the overview", async () => {
      for (const role of ["owner", "admin", "member", "viewer"] as const) {
        const { store } = makeStore()
        const service = createOverviewService({ store })
        const ctx = makeServiceContext({ role })
        await expectAllowed(() => service.getOverview(ctx))
      }
    })

    test("a context missing workspace/actor is denied", async () => {
      const { store } = makeStore()
      const service = createOverviewService({ store })
      const ctx = makeServiceContext({ role: "owner", workspaceId: "", actorId: "" })
      await expectDenied(() => service.getOverview(ctx))
    })
  })
})
