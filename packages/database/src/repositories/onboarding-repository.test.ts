import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import { onboardingProgress, type OnboardingProgressRow } from "../schema/onboarding"
import {
  createOnboardingRepository,
  readSampleData,
  readStepCompletedAt,
} from "./onboarding-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const ROW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const MIGRATION = new URL("../../migrations/0310_onboarding.sql", import.meta.url)

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

function makeRow(overrides: Partial<OnboardingProgressRow> = {}): OnboardingProgressRow {
  return {
    id: ROW_ID,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    dismissedAt: null,
    dismissedBy: null,
    stepCompletedAt: {},
    sampleData: [],
    sampleDataSeededAt: null,
    sampleDataSeededBy: null,
    ...overrides,
  }
}

describe("onboarding/schema", () => {
  test("onboarding_progress exposes the BaseRecord contract plus its own columns", () => {
    const cols = onboardingProgress as unknown as Record<string, unknown>
    for (const col of ["id", "workspaceId", "createdAt", "updatedAt", "deletedAt"]) {
      expect(cols[col], col).toBeDefined()
    }
    expect(cols.dismissedAt).toBeDefined()
    expect(cols.stepCompletedAt).toBeDefined()
    expect(cols.sampleData).toBeDefined()
  })
})

describe("onboarding/repository", () => {
  test("getSignals maps sequential queries to named signals (workspace, people, deals, pipelines, memberships)", async () => {
    const repo = createOnboardingRepository()
    const db = mockDb([
      [{ timezone: "America/New_York", currency: "EUR" }],
      [{ value: 3 }],
      [{ value: 5 }],
      [{ value: 2 }],
      [{ value: 4 }],
    ])
    const signals = await repo.getSignals(db, WS)
    expect(signals).toEqual({
      workspaceTimezone: "America/New_York",
      workspaceCurrency: "EUR",
      peopleCount: 3,
      dealsCount: 5,
      pipelinesCount: 2,
      membershipsCount: 4,
    })
  })

  test("getSignals defaults to UTC/USD/0 counts when the workspace row is missing", async () => {
    const repo = createOnboardingRepository()
    const db = mockDb([[], [], [], [], []])
    const signals = await repo.getSignals(db, WS)
    expect(signals).toEqual({
      workspaceTimezone: "UTC",
      workspaceCurrency: "USD",
      peopleCount: 0,
      dealsCount: 0,
      pipelinesCount: 0,
      membershipsCount: 0,
    })
  })

  test("getByWorkspace returns null when no row exists", async () => {
    const repo = createOnboardingRepository()
    await expect(repo.getByWorkspace(mockDb([[]]), WS)).resolves.toBeNull()
  })

  test("getOrCreate returns the existing row without inserting", async () => {
    const repo = createOnboardingRepository()
    const row = makeRow()
    const result = await repo.getOrCreate(mockDb([[row]]), WS)
    expect(result).toBe(row)
  })

  test("getOrCreate inserts on first access, and falls back to a re-read if it loses the create race", async () => {
    const repo = createOnboardingRepository()
    const row = makeRow()
    // getByWorkspace -> [] (missing), insert.returning() -> [] (lost the
    // unique-index race to a concurrent request), re-read -> [row].
    const result = await repo.getOrCreate(mockDb([[], [], [row]]), WS)
    expect(result).toBe(row)
  })

  test("markStepObservedDone merges one key and is idempotent once observed", async () => {
    const repo = createOnboardingRepository()
    const existing = makeRow()
    const updated = makeRow({ stepCompletedAt: { first_deal: "2026-01-02T00:00:00.000Z" } })
    const result = await repo.markStepObservedDone(
      mockDb([[existing], [updated]]),
      WS,
      "first_deal",
      "2026-01-02T00:00:00.000Z",
    )
    expect(readStepCompletedAt(result)).toEqual({ first_deal: "2026-01-02T00:00:00.000Z" })
  })

  test("markStepObservedDone does not re-write a key that is already cached", async () => {
    const repo = createOnboardingRepository()
    const already = makeRow({ stepCompletedAt: { first_deal: "2026-01-01T00:00:00.000Z" } })
    // Only one queued result: getOrCreate. If the implementation issued an
    // update anyway, the shared step counter would run out and the next
    // `.then()` would resolve `[]`, so asserting the *original* timestamp
    // survives proves no update query ran.
    const result = await repo.markStepObservedDone(
      mockDb([[already]]),
      WS,
      "first_deal",
      "2099-01-01T00:00:00.000Z",
    )
    expect(readStepCompletedAt(result)).toEqual({ first_deal: "2026-01-01T00:00:00.000Z" })
  })

  test("setDismissed and setSampleData round-trip through the update path", async () => {
    const repo = createOnboardingRepository()
    const existing = makeRow()
    const dismissed = makeRow({ dismissedAt: new Date("2026-01-03T00:00:00Z"), dismissedBy: "u1" })
    const afterDismiss = await repo.setDismissed(mockDb([[existing], [dismissed]]), WS, true, "u1")
    expect(afterDismiss.dismissedAt).not.toBeNull()

    const sampleRow = makeRow({ sampleData: [{ module: "person", recordId: "p1" }] })
    const afterSeed = await repo.setSampleData(
      mockDb([[existing], [sampleRow]]),
      WS,
      [{ module: "person", recordId: "p1" }],
      "u1",
    )
    expect(readSampleData(afterSeed)).toEqual([{ module: "person", recordId: "p1" }])
  })
})

describe("onboarding/migration", () => {
  test("0310 creates onboarding_progress with a per-workspace unique index and an FK to workspaces", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS onboarding_progress")
    expect(sql).toContain("onboarding_progress_workspace_uidx")
    expect(sql).toContain("REFERENCES workspaces (id) ON DELETE CASCADE")
    expect(sql).toContain("step_completed_at JSONB")
    expect(sql).toContain("sample_data JSONB")
  })

  test("no foreign key to a table this module doesn't own", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const references = [...sql.matchAll(/REFERENCES\s+(\w+)/g)].map((m) => m[1] ?? "")
    for (const table of references) {
      expect(["workspaces", "users"]).toContain(table)
    }
  })
})
