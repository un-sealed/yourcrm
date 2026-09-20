import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import { createOverviewRepository } from "./overview-repository"

const WS = "11111111-1111-4111-8111-111111111111"

/** Thenable chain stub: every query builder call returns the proxy; each await pops one queued result. */
function mockDb(queued: unknown[][] = []) {
  let step = 0
  const proxy = new Proxy(function () {}, {
    get(_target, prop: string | symbol) {
      if (prop === "then") {
        return (resolve: (value: unknown) => void) => {
          resolve(queued[step] ?? [])
          step += 1
        }
      }
      return (..._args: unknown[]) => proxy
    },
  })
  return proxy as unknown as Database
}

describe("overview/repository", () => {
  test("getOverview assembles KPIs, zero-filled trend/activity series and recent deals from sequential queries", async () => {
    const repo = createOverviewRepository()
    const now = new Date("2026-01-31T12:00:00.000Z")

    const db = mockDb([
      /* 1. workspace currency          */ [{ currency: "EUR" }],
      /* 2. open pipeline value          */ [{ total: "1000.50" }],
      /* 3. won this month, prior window */ [{ value: 2 }],
      /* 4. won value this month         */ [{ total: "500.25" }],
      /* 5. new contacts, current        */ [{ value: 4 }],
      /* 6. new contacts, prior          */ [{ value: 1 }],
      /* 7. activities this week, prior  */ [{ value: 3 }],
      /* 8. deals created by day         */ [
        { day: "2026-01-05", count: 2 },
        { day: "2026-01-31", count: 1 },
      ],
      /* 9. deals won by day             */ [{ day: "2026-01-31", count: 1 }],
      /* 10. activities by day           */ [
        { day: "2026-01-25", count: 5 },
        { day: "2026-01-31", count: 2 },
      ],
      /* 11. recent deals (joined)       */ [
        {
          id: "d1",
          name: "Deal One",
          company: "Acme",
          amount: "250.00",
          currency: "USD",
          stage: "won",
          updatedAt: new Date("2026-01-30T00:00:00.000Z"),
        },
        {
          id: "d2",
          name: "Deal Two",
          company: null,
          amount: null,
          currency: "USD",
          stage: "qualification",
          updatedAt: new Date("2026-01-29T00:00:00.000Z"),
        },
      ],
    ])

    const result = await repo.getOverview(db, WS, now)

    expect(result.workspaceCurrency).toBe("EUR")
    expect(result.openPipelineValue).toEqual({ value: 1000.5, priorValue: null })
    // Current-month won count is derived from the trend's own `won` sum
    // (1, from 2026-01-31), not from a separate query — see the repo's
    // "derived from the same grouped data as the chart" comment.
    expect(result.dealsWonThisMonth).toEqual({ current: 1, prior: 2 })
    expect(result.newContactsThisMonth).toEqual({ current: 4, prior: 1 })
    // Likewise this-week activity count is the sum of activityByDay (5+2=7).
    expect(result.activitiesThisWeek).toEqual({ current: 7, prior: 3 })
    expect(result.wonValueThisMonth).toBe(500.25)

    // 30 days, ascending, zero-filled, Jan 2 .. Jan 31 inclusive.
    expect(result.trend).toHaveLength(30)
    expect(result.trend[0]?.date).toBe("2026-01-02")
    expect(result.trend.at(-1)?.date).toBe("2026-01-31")
    expect(result.trend.find((p) => p.date === "2026-01-05")).toEqual({
      date: "2026-01-05",
      created: 2,
      won: 0,
    })
    expect(result.trend.find((p) => p.date === "2026-01-31")).toEqual({
      date: "2026-01-31",
      created: 1,
      won: 1,
    })
    expect(result.trend.find((p) => p.date === "2026-01-10")).toEqual({
      date: "2026-01-10",
      created: 0,
      won: 0,
    })

    // 7 days incl. today, ascending, zero-filled, with weekday labels.
    expect(result.activityByDay).toHaveLength(7)
    expect(result.activityByDay).toEqual([
      { date: "2026-01-25", label: "Sun", count: 5 },
      { date: "2026-01-26", label: "Mon", count: 0 },
      { date: "2026-01-27", label: "Tue", count: 0 },
      { date: "2026-01-28", label: "Wed", count: 0 },
      { date: "2026-01-29", label: "Thu", count: 0 },
      { date: "2026-01-30", label: "Fri", count: 0 },
      { date: "2026-01-31", label: "Sat", count: 2 },
    ])

    // NUMERIC(14,2) arrives as a decimal string; a null amount stays null
    // rather than becoming 0.
    expect(result.recentDeals).toEqual([
      {
        id: "d1",
        name: "Deal One",
        company: "Acme",
        amount: 250,
        currency: "USD",
        stage: "won",
        updatedAt: "2026-01-30T00:00:00.000Z",
      },
      {
        id: "d2",
        name: "Deal Two",
        company: null,
        amount: null,
        currency: "USD",
        stage: "qualification",
        updatedAt: "2026-01-29T00:00:00.000Z",
      },
    ])
  })

  test("getOverview defaults to USD and all-zero signals for a workspace with no data", async () => {
    const repo = createOverviewRepository()
    const now = new Date("2026-01-31T12:00:00.000Z")
    const db = mockDb([
      [], // workspace currency missing
      [{ total: "0" }],
      [{ value: 0 }],
      [{ total: "0" }],
      [{ value: 0 }],
      [{ value: 0 }],
      [{ value: 0 }],
      [],
      [],
      [],
      [],
    ])

    const result = await repo.getOverview(db, WS, now)

    expect(result.workspaceCurrency).toBe("USD")
    expect(result.openPipelineValue).toEqual({ value: 0, priorValue: null })
    expect(result.dealsWonThisMonth).toEqual({ current: 0, prior: 0 })
    expect(result.newContactsThisMonth).toEqual({ current: 0, prior: 0 })
    expect(result.activitiesThisWeek).toEqual({ current: 0, prior: 0 })
    expect(result.wonValueThisMonth).toBe(0)
    expect(result.trend.every((p) => p.created === 0 && p.won === 0)).toBe(true)
    expect(result.activityByDay.every((p) => p.count === 0)).toBe(true)
    expect(result.recentDeals).toEqual([])
  })
})
