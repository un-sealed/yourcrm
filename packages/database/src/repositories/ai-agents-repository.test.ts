import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import { aiAgentRuns, aiAgents, type AiAgent, type AiAgentRun } from "../schema/ai-agents"
import {
  clampAiAgentBudgetValue,
  createAiAgentsRepository,
  normalizeAiAgentName,
  validateAiAgentRunStatus,
  validateAiAgentStatus,
  validateAiAgentTools,
  validateAiAgentTriggerType,
  AiAgentRepositoryError,
} from "./ai-agents-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const OWNER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const MIGRATION = new URL("../../migrations/0400_ai_agents.sql", import.meta.url)

/** Thenable chain stub: builder calls return the proxy; each await pops one result. */
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

function makeAgent(overrides: Partial<AiAgent> = {}): AiAgent {
  return {
    id: AGENT_ID,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    ownerId: OWNER_ID,
    name: "Data hygiene",
    description: null,
    instructions: "Find people with a missing title.",
    model: null,
    tools: ["crm_query"],
    triggerType: "manual",
    triggerEvent: null,
    triggerEntityType: null,
    status: "disabled",
    maxSteps: 6,
    maxToolCalls: 12,
    maxTotalTokens: 60_000,
    lastRunAt: null,
    ...overrides,
  }
}

function makeRun(overrides: Partial<AiAgentRun> = {}): AiAgentRun {
  return {
    id: RUN_ID,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    agentId: AGENT_ID,
    triggerType: "event",
    triggerEvent: "person.created",
    triggerEventId: "evt-1",
    triggerPayload: null,
    input: null,
    entityType: "person",
    entityId: null,
    actorId: OWNER_ID,
    actorRole: null,
    status: "queued",
    depth: 0,
    parentRunId: null,
    steps: 0,
    toolCallCount: 0,
    proposalCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    latencyMs: 0,
    costMicros: null,
    providerId: null,
    model: null,
    summary: null,
    stepLog: null,
    errorCode: null,
    error: null,
    correlationId: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  }
}

describe("ai-agents/schema", () => {
  test("both tables carry the BaseRecord contract and workspace scoping", () => {
    for (const table of [aiAgents, aiAgentRuns]) {
      const columns = table as unknown as Record<string, unknown>
      for (const column of ["id", "createdAt", "updatedAt", "deletedAt", "workspaceId"] as const) {
        expect(columns[column], `${column}`).toBeDefined()
      }
    }
  })

  test("the migration creates both tables with the guarantees the module relies on", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS ai_agents")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS ai_agent_runs")
    // IDEMPOTENCY is a database fact, not a service decision.
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_runs_event_idx")
    expect(sql).toContain("ON ai_agent_runs (agent_id, trigger_event_id)")
    // Budgets cannot be widened past the ceilings by writing to the table.
    expect(sql).toContain("CHECK (max_steps BETWEEN 1 AND 12)")
    expect(sql).toContain("CHECK (max_tool_calls BETWEEN 1 AND 24)")
    expect(sql).toContain("CHECK (max_total_tokens BETWEEN 1 AND 200000)")
    // `exhausted` is a first-class outcome.
    expect(sql).toContain("'exhausted'")
    expect(sql).toContain("cost_micros BIGINT")
  })

  test("no foreign key points at a table this module does not own", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const references = [...sql.matchAll(/REFERENCES\s+(\w+)/gi)].map((match) => match[1])
    expect(new Set(references)).toEqual(new Set(["ai_agents", "ai_agent_runs"]))
  })

  test("the migration stores no CRM mutation of its own", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    // An agent proposes; the approval queue owns the proposal. There is no
    // second place where "what AI wanted to do" is recorded.
    expect(sql).not.toMatch(/CREATE TABLE[^;]*ai_agent_actions/i)
  })
})

describe("ai-agents/validation", () => {
  test("names trim, collapse whitespace and are bounded", () => {
    expect(normalizeAiAgentName("  Data   hygiene ")).toBe("Data hygiene")
    expect(normalizeAiAgentName("x".repeat(400))).toHaveLength(160)
    expect(() => normalizeAiAgentName("   ")).toThrow(AiAgentRepositoryError)
  })

  test("statuses, trigger types and run statuses are allowlisted", () => {
    expect(validateAiAgentStatus("enabled")).toBe("enabled")
    expect(() => validateAiAgentStatus("live")).toThrow(/disabled, enabled/)
    expect(validateAiAgentTriggerType("event")).toBe("event")
    expect(() => validateAiAgentTriggerType("cron")).toThrow(/manual, event/)
    expect(validateAiAgentRunStatus("exhausted")).toBe("exhausted")
    expect(() => validateAiAgentRunStatus("done")).toThrow(/exhausted/)
  })

  test("the tool allowlist is deduplicated, bounded and name-checked", () => {
    expect(validateAiAgentTools(["crm_query", "crm_query", " "])).toEqual(["crm_query"])
    expect(validateAiAgentTools(null)).toEqual([])
    expect(() => validateAiAgentTools(["DROP TABLE"])).toThrow(/not a valid tool name/)
    expect(() =>
      validateAiAgentTools(Array.from({ length: 17 }, (_, i) => `t${String(i)}`)),
    ).toThrow(/at most 16 tools/)
  })

  test("budgets are clamped to their ceilings on the way into the table", () => {
    expect(clampAiAgentBudgetValue(9_999, 6, 12)).toBe(12)
    expect(clampAiAgentBudgetValue(0, 6, 12)).toBe(1)
    expect(clampAiAgentBudgetValue(null, 6, 12)).toBe(6)
    expect(clampAiAgentBudgetValue(4, 6, 12)).toBe(4)
  })

  test("a run counter cannot be negative", async () => {
    const repository = createAiAgentsRepository()
    await expect(
      repository.updateRun(mockDb([[makeRun()]]), WS, RUN_ID, { totalTokens: -1 }),
    ).rejects.toThrow(/non-negative/)
  })
})

describe("ai-agents/repository", () => {
  test("a new agent is born disabled and owned, whatever the caller asked for", async () => {
    const repository = createAiAgentsRepository()
    const agent = await repository.create(mockDb([[makeAgent()]]), WS, {
      name: "Data hygiene",
      instructions: "Find people with a missing title.",
      tools: ["crm_query"],
    })
    expect(agent.status).toBe("disabled")
    expect(agent.ownerId).toBe(OWNER_ID)
  })

  test("createRun reports `created: false` when the unique index rejects a redelivery", async () => {
    const repository = createAiAgentsRepository()
    // Insert returns no rows (conflict), then the existing row comes back.
    const db = mockDb([[], [makeRun()]])
    const result = await repository.createRun(db, WS, {
      agentId: AGENT_ID,
      triggerType: "event",
      triggerEvent: "person.created",
      triggerEventId: "evt-1",
    })
    expect(result.created).toBe(false)
    expect(result.run.id).toBe(RUN_ID)
  })

  test("createRun reports `created: true` for a first delivery", async () => {
    const repository = createAiAgentsRepository()
    const result = await repository.createRun(mockDb([[makeRun()]]), WS, {
      agentId: AGENT_ID,
      triggerType: "manual",
      triggerEventId: "manual:1",
    })
    expect(result.created).toBe(true)
  })

  test("a conflict with no row is a loud failure, never a silent second run", async () => {
    const repository = createAiAgentsRepository()
    await expect(
      repository.createRun(mockDb([[], []]), WS, {
        agentId: AGENT_ID,
        triggerType: "event",
        triggerEventId: "evt-1",
      }),
    ).rejects.toThrow(/conflict without a row/)
  })

  test("the repository exposes no way to write another module's table", () => {
    const repository = createAiAgentsRepository()
    const methods = Object.keys(repository)
    expect(methods).not.toContain("applyAiAction")
    for (const name of methods) {
      expect(name).not.toMatch(/person|company|deal|lead|task|email/i)
    }
  })
})
