import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import {
  computeCsHealthFactors,
  createCustomerSuccessRepository,
  CS_HEALTH_LOOKBACK_DAYS,
  CS_PLAYBOOK_KEYS,
  CsPlaybookError,
  describeCsPlaybooks,
  findCsPlaybook,
  isCsPlaybookKey,
  resolveCsPlaybook,
} from "./customer-success-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const COMPANY = "22222222-2222-4222-8222-222222222222"

/**
 * Thenable chain stub (same pattern as `reports-repository.test.ts`): every
 * builder call returns the proxy; each `await` pops one queued result.
 * `computeCsHealthFactors` issues exactly three sequential selects
 * (last-activity, recent-activity-count, open-deals-count), so tests queue
 * one row array per select, in that order.
 */
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

describe("customer-success-repository/computeCsHealthFactors", () => {
  test("no activity ever, no open deals: recency and expansion bottom out, contact volume tops out", async () => {
    const db = mockDb([[{ lastActivityAt: null }], [{ count: 0 }], [{ count: 0 }]])
    const result = await computeCsHealthFactors(db, WS, COMPANY)

    const recency = result.factors.find((f) => f.key === "last_activity_recency")
    const tickets = result.factors.find((f) => f.key === "ticket_volume")
    const deals = result.factors.find((f) => f.key === "open_deals")

    expect(recency?.rawValue).toBeNull()
    expect(recency?.normalizedScore).toBe(0)
    expect(tickets?.rawValue).toBe(0)
    expect(tickets?.normalizedScore).toBe(100)
    expect(deals?.rawValue).toBe(0)
    expect(deals?.normalizedScore).toBe(0)
    // 0*0.4 + 100*0.3 + 0*0.3
    expect(result.score).toBeCloseTo(30, 5)
  })

  test("activity today, some tickets, a couple of open deals: blended score", async () => {
    const db = mockDb([[{ lastActivityAt: new Date() }], [{ count: 5 }], [{ count: 2 }]])
    const result = await computeCsHealthFactors(db, WS, COMPANY)

    const recency = result.factors.find((f) => f.key === "last_activity_recency")
    const tickets = result.factors.find((f) => f.key === "ticket_volume")
    const deals = result.factors.find((f) => f.key === "open_deals")

    expect(recency?.rawValue).toBe(0)
    expect(recency?.normalizedScore).toBe(100)
    expect(tickets?.rawValue).toBe(5)
    expect(tickets?.normalizedScore).toBe(60) // 100 - 5*8
    expect(deals?.rawValue).toBe(2)
    expect(deals?.normalizedScore).toBe(50) // min(2,4)*25
    // 100*0.4 + 60*0.3 + 50*0.3
    expect(result.score).toBeCloseTo(73, 5)
  })

  test("heavy ticket volume floors that factor at zero; every score stays within [0, 100]", async () => {
    const db = mockDb([[{ lastActivityAt: null }], [{ count: 50 }], [{ count: 10 }]])
    const result = await computeCsHealthFactors(db, WS, COMPANY)
    for (const factor of result.factors) {
      expect(factor.normalizedScore).toBeGreaterThanOrEqual(0)
      expect(factor.normalizedScore).toBeLessThanOrEqual(100)
    }
    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result.score).toBeLessThanOrEqual(100)
    const tickets = result.factors.find((f) => f.key === "ticket_volume")
    expect(tickets?.normalizedScore).toBe(0)
  })

  test("lookback window is documented on the ticket-volume factor label", async () => {
    const db = mockDb([[{ lastActivityAt: null }], [{ count: 0 }], [{ count: 0 }]])
    const result = await computeCsHealthFactors(db, WS, COMPANY)
    const tickets = result.factors.find((f) => f.key === "ticket_volume")
    expect(tickets?.label).toContain(String(CS_HEALTH_LOOKBACK_DAYS))
  })
})

describe("customer-success-repository/playbook allowlist", () => {
  test("describeCsPlaybooks lists every registered playbook with its task count", () => {
    const catalogue = describeCsPlaybooks()
    expect(catalogue.length).toBe(CS_PLAYBOOK_KEYS.length)
    for (const entry of catalogue) {
      expect(CS_PLAYBOOK_KEYS).toContain(entry.key)
      expect(entry.taskCount).toBeGreaterThan(0)
    }
  })

  test("resolveCsPlaybook throws for an unknown key; never returns a partial match", () => {
    expect(() => resolveCsPlaybook("not-a-real-playbook")).toThrow(CsPlaybookError)
    expect(() => resolveCsPlaybook(123)).toThrow(CsPlaybookError)
  })

  test("findCsPlaybook is the non-throwing companion", () => {
    expect(findCsPlaybook("not-a-real-playbook")).toBeNull()
    const known = CS_PLAYBOOK_KEYS[0] as string
    expect(findCsPlaybook(known)?.key).toBe(known)
  })

  test("isCsPlaybookKey narrows only registered keys", () => {
    expect(isCsPlaybookKey("onboarding")).toBe(true)
    expect(isCsPlaybookKey("nope")).toBe(false)
    expect(isCsPlaybookKey(42)).toBe(false)
  })

  test("recordApplication rejects an unknown playbook key before any insert", async () => {
    const repository = createCustomerSuccessRepository()
    const db = mockDb([])
    await expect(
      repository.playbookTasks.recordApplication(db, WS, "account_1", "not-real", "task_1"),
    ).rejects.toBeInstanceOf(CsPlaybookError)
  })
})
