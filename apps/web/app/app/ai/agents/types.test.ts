import { describe, expect, test } from "bun:test"
import {
  canEnableAiAgent,
  describeAiAgentRun,
  describeAiAgentTrigger,
  formatAiAgentCost,
  formatAiAgentTimestamp,
  AI_AGENT_RUN_STATUS_LABELS,
  type AiAgent,
  type AiAgentRun,
} from "./types"

function makeAgent(overrides: Partial<AiAgent> = {}): AiAgent {
  return {
    id: "agent_1",
    workspaceId: "ws",
    name: "Data hygiene",
    description: null,
    instructions: "Find people with a missing title.",
    model: null,
    tools: ["crm_query", "crm_propose_change"],
    triggerType: "manual",
    triggerEvent: null,
    triggerEntityType: null,
    ownerId: "user_1",
    status: "disabled",
    maxSteps: 6,
    maxToolCalls: 12,
    maxTotalTokens: 60_000,
    lastRunAt: null,
    createdAt: "2026-09-19T10:00:00.000Z",
    updatedAt: "2026-09-19T10:00:00.000Z",
    ...overrides,
  }
}

function makeRun(overrides: Partial<AiAgentRun> = {}): AiAgentRun {
  return {
    id: "run_1",
    agentId: "agent_1",
    triggerType: "manual",
    triggerEvent: null,
    triggerEventId: "manual:1",
    status: "succeeded",
    steps: 2,
    toolCallCount: 1,
    proposalCount: 1,
    promptTokens: 1_000,
    completionTokens: 300,
    totalTokens: 1_300,
    latencyMs: 200,
    costMicros: 2,
    model: "deepseek-v4-flash",
    summary: "Proposed one title fix.",
    error: null,
    startedAt: null,
    finishedAt: null,
    createdAt: "2026-09-19T10:00:00.000Z",
    ...overrides,
  }
}

describe("web/ai-agents types", () => {
  test("the trigger reads as a sentence", () => {
    expect(describeAiAgentTrigger(makeAgent())).toBe("Runs when you press Run")
    expect(
      describeAiAgentTrigger(
        makeAgent({ triggerType: "event", triggerEvent: "person.created" }),
      ),
    ).toBe("Runs on person.created")
  })

  test("cost renders from micro-USD, and an unknown price is not a zero", () => {
    expect(formatAiAgentCost(null)).toBe("—")
    expect(formatAiAgentCost(0)).toBe("$0.00")
    expect(formatAiAgentCost(2)).toBe("$0.0000")
    expect(formatAiAgentCost(2_500_000)).toBe("$2.50")
  })

  test("a run line names its spend and what it PROPOSED", () => {
    const line = describeAiAgentRun(makeRun())
    expect(line).toContain("2 steps")
    expect(line).toContain("1300 tokens")
    expect(line).toContain("1 change proposed")
    expect(describeAiAgentRun(makeRun({ proposalCount: 0 }))).not.toContain("proposed")
  })

  test("`exhausted` is explained as a budget stop, not an error", () => {
    expect(AI_AGENT_RUN_STATUS_LABELS.exhausted).toBe("Stopped at its budget")
  })

  test("an ownerless agent cannot be enabled: it would have nobody to run as", () => {
    expect(canEnableAiAgent(makeAgent())).toBe(true)
    expect(canEnableAiAgent(makeAgent({ ownerId: null }))).toBe(false)
    expect(canEnableAiAgent(makeAgent({ status: "enabled" }))).toBe(false)
  })

  test("a missing timestamp renders as a dash, never as Invalid Date", () => {
    expect(formatAiAgentTimestamp(null)).toBe("—")
  })
})
