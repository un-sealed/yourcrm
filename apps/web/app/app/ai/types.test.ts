import { describe, expect, test } from "bun:test"
import {
  describeAttribution,
  formatCostMicros,
  isChatBubble,
  toolCallsForRun,
  toolOutcomeTone,
  type AiMessage,
  type AiRun,
} from "./types"

function makeMessage(overrides: Partial<AiMessage> = {}): AiMessage {
  return {
    id: "m1",
    conversationId: "c1",
    role: "assistant",
    content: "There are 4 open deals.",
    model: "deepseek-v4-flash",
    providerId: "openai-compatible",
    runId: "r1",
    toolCalls: null,
    toolCallId: null,
    toolName: null,
    createdAt: "2026-09-19T10:00:00.000Z",
    ...overrides,
  }
}

function makeRun(overrides: Partial<AiRun> = {}): AiRun {
  return {
    id: "r1",
    conversationId: "c1",
    providerId: "openai-compatible",
    model: "deepseek-v4-flash",
    promptTokens: 900,
    completionTokens: 100,
    totalTokens: 1000,
    latencyMs: 820,
    costMicros: null,
    outcome: "succeeded",
    toolCallCount: 1,
    createdAt: "2026-09-19T10:00:00.000Z",
    ...overrides,
  }
}

describe("ai/types", () => {
  test("only non-empty user and assistant turns render as bubbles", () => {
    expect(isChatBubble(makeMessage())).toBe(true)
    expect(isChatBubble(makeMessage({ role: "user" }))).toBe(true)
    expect(isChatBubble(makeMessage({ role: "tool" }))).toBe(false)
    // A tool-calling turn has no prose: it is shown as a tool chip instead.
    expect(isChatBubble(makeMessage({ content: "" }))).toBe(false)
  })

  test("attribution names the model, tokens and latency", () => {
    expect(describeAttribution(makeMessage(), makeRun())).toBe(
      "deepseek-v4-flash · 1000 tokens · 820 ms",
    )
  })

  test("attribution falls back to the run's model when the row has none", () => {
    expect(describeAttribution(makeMessage({ model: null }), makeRun())).toContain(
      "deepseek-v4-flash",
    )
  })

  test("attribution includes cost only when the model is priced", () => {
    expect(describeAttribution(makeMessage(), makeRun({ costMicros: 1250 }))).toContain("$0.001250")
    expect(describeAttribution(makeMessage(), makeRun())).not.toContain("$")
  })

  test("a sub-microdollar cost is shown honestly, not as zero", () => {
    expect(formatCostMicros(0)).toBe("<$0.000001")
    expect(formatCostMicros(2_500_000)).toBe("$2.500000")
  })

  test("tool outcomes map to accessible tones (never colour alone)", () => {
    expect(toolOutcomeTone("succeeded")).toBe("success")
    expect(toolOutcomeTone("denied")).toBe("warning")
    expect(toolOutcomeTone("failed")).toBe("destructive")
  })

  test("tool rows group by run so each answer shows what it looked at", () => {
    const rows = [
      makeMessage({ id: "t1", role: "tool", runId: "r1", toolName: "crm_query" }),
      makeMessage({ id: "t2", role: "tool", runId: "r2", toolName: "crm_query" }),
      makeMessage({ id: "m2", role: "assistant", runId: "r1" }),
    ]
    expect(toolCallsForRun(rows, "r1").map((row) => row.id)).toEqual(["t1"])
  })
})
