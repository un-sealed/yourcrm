import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import { createOverviewService, type OverviewService } from "@yourcrm/crm/src/overview"
import type { OverviewSignals, OverviewStore } from "@yourcrm/crm/src/overview"
import { createApiClient, makeSession } from "@yourcrm/testing"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes } from "./overview"

const BASE_SIGNALS: OverviewSignals = {
  workspaceCurrency: "USD",
  openPipelineValue: { value: 12000, priorValue: null },
  dealsWonThisMonth: { current: 2, prior: 1 },
  newContactsThisMonth: { current: 6, prior: 4 },
  activitiesThisWeek: { current: 9, prior: 5 },
  wonValueThisMonth: 3000,
  trend: [{ date: "2026-01-31", created: 1, won: 1 }],
  activityByDay: [{ date: "2026-01-31", label: "Sat", count: 3 }],
  recentDeals: [
    {
      id: "deal_1",
      name: "Acme renewal",
      company: "Acme Inc",
      amount: 3000,
      currency: "USD",
      stage: "won",
      updatedAt: "2026-01-31T00:00:00.000Z",
    },
  ],
}

function makeStore(overrides: Partial<OverviewSignals> = {}): OverviewStore {
  const signals: OverviewSignals = { ...BASE_SIGNALS, ...overrides }
  return { getOverview: async () => signals }
}

function makeTestApp(session: { current: Session | null }, service: OverviewService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/overview", createRoutes({ service }))
  return app
}

describe("api/overview", () => {
  let session: { current: Session | null }

  beforeEach(() => {
    session = { current: makeSession({ role: "owner" }) }
  })

  test("unauthenticated requests get UNAUTHORIZED", async () => {
    session.current = null
    const service = createOverviewService({ store: makeStore() })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/overview")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("returns the overview envelope with computed KPIs, trend, goal and recent deals", async () => {
    const service = createOverviewService({ store: makeStore() })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/overview")
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    const data = body.data as {
      kpis: {
        openPipelineValue: { value: number; delta: number | null; currency?: string }
        dealsWonThisMonth: { value: number; delta: number | null }
      }
      trend: unknown[]
      activityByDay: unknown[]
      goal: { attained: number; wonValue: number; targetValue: number }
      recentDeals: unknown[]
    }

    expect(data.kpis.openPipelineValue).toEqual({ value: 12000, delta: null, currency: "USD" })
    expect(data.kpis.dealsWonThisMonth).toEqual({ value: 2, delta: 1 })
    expect(data.trend).toEqual(BASE_SIGNALS.trend)
    expect(data.activityByDay).toEqual(BASE_SIGNALS.activityByDay)
    expect(data.goal).toEqual({ attained: 0.2, wonValue: 3000, targetValue: 15000 })
    expect(data.recentDeals).toEqual(BASE_SIGNALS.recentDeals)
  })

  test("every workspace role (including viewer) can read the overview", async () => {
    session.current = makeSession({ role: "viewer" })
    const service = createOverviewService({ store: makeStore() })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/overview")
    expect(res.status).toBe(200)
  })
})
