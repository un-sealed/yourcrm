import { describe, expect, test } from "bun:test"
import {
  actionItemsOf,
  analysisStatusTone,
  analysisTypeLabel,
  describeAnalysisAttribution,
  describeAnalysisBounds,
  describeAnalysisRow,
  formatConversationTimestamp,
  highlightsOf,
  sentimentOf,
  sentimentTone,
  subjectTypeLabel,
  summaryTextOf,
  topicsOf,
  type ConversationAnalysis,
} from "./types"

function makeAnalysis(overrides: Partial<ConversationAnalysis> = {}): ConversationAnalysis {
  return {
    id: "an_1",
    workspaceId: "ws_1",
    subjectType: "email_thread",
    subjectId: "thread_1",
    analysisType: "summary",
    status: "succeeded",
    providerId: "openai-compatible",
    model: "deepseek-v4-flash",
    runId: "3f7a1c22-0000-4000-8000-000000000000",
    output: { kind: "summary", summary: "Maria asked to move the payment date.", highlights: [] },
    promptTokens: 1_000,
    completionTokens: 24,
    totalTokens: 1_024,
    latencyMs: 812,
    sourceChars: 3_200,
    analysedChars: 3_200,
    truncated: false,
    errorCode: null,
    createdAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-20T10:00:01.000Z",
    ...overrides,
  }
}

describe("web/conversation-intelligence/types", () => {
  test("every analysis shows the model, the tokens and the run", () => {
    expect(describeAnalysisAttribution(makeAnalysis())).toBe(
      "deepseek-v4-flash · 1,024 tokens · 812 ms · run 3f7a1c22",
    )
  })

  test("the bounds line says what the model actually read", () => {
    expect(describeAnalysisBounds(makeAnalysis())).toBe("Analysed all 3,200 characters")
    expect(
      describeAnalysisBounds({ sourceChars: 1_800_000, analysedChars: 24_000, truncated: true }),
    ).toBe(
      "Analysed 24,000 of 1,800,000 characters — the middle was left out to stay inside the size limit",
    )
  })

  test("status and sentiment tones are distinguishable, not all grey", () => {
    expect(analysisStatusTone("succeeded")).toBe("success")
    expect(analysisStatusTone("queued")).toBe("info")
    expect(analysisStatusTone("failed")).toBe("destructive")
    expect(sentimentTone("positive")).toBe("success")
    expect(sentimentTone("negative")).toBe("destructive")
    expect(sentimentTone("mixed")).toBe("warning")
    expect(sentimentTone("neutral")).toBe("info")
  })

  test("labels never fall back to a blank string", () => {
    expect(analysisTypeLabel("action_items")).toBe("Action items")
    expect(analysisTypeLabel("something_new")).toBe("something_new")
    expect(subjectTypeLabel("email_thread")).toBe("Email thread")
    expect(subjectTypeLabel("telepathy")).toBe("telepathy")
  })

  test("output readers survive whatever the server sent", () => {
    expect(summaryTextOf(null)).toBe("")
    expect(summaryTextOf({ summary: 42 })).toBe("")
    expect(highlightsOf({ highlights: ["a", 7, "", "b"] })).toEqual(["a", "b"])
    expect(actionItemsOf({ items: [{ title: "Call Ada" }, { owner: "x" }, 3] })).toEqual([
      { title: "Call Ada", owner: null, dueDate: null },
    ])
    expect(topicsOf({ topics: [{ topic: "Renewal", mentions: 3 }, { name: "x" }] })).toEqual([
      { topic: "Renewal", mentions: 3 },
    ])
    expect(sentimentOf({ kind: "summary" })).toBeNull()
  })

  test("a sentiment always carries its caveat through to the view", () => {
    const view = sentimentOf({
      kind: "sentiment",
      label: "negative",
      score: -0.4,
      rationale: "Repeated chasing.",
      caveat: "Sentiment is a model's impression of the text only.",
    })
    expect(view).toEqual({
      label: "negative",
      score: -0.4,
      rationale: "Repeated chasing.",
      caveat: "Sentiment is a model's impression of the text only.",
    })
  })

  test("the list line describes each kind of analysis usefully", () => {
    expect(describeAnalysisRow(makeAnalysis())).toBe("Maria asked to move the payment date.")
    expect(describeAnalysisRow(makeAnalysis({ status: "queued" }))).toBe("Waiting to run")
    expect(
      describeAnalysisRow(
        makeAnalysis({ status: "failed", errorCode: "AI_PROVIDER_TIMEOUT", output: null }),
      ),
    ).toBe("AI_PROVIDER_TIMEOUT")
    expect(
      describeAnalysisRow(
        makeAnalysis({
          analysisType: "action_items",
          output: { kind: "action_items", items: [{ title: "a" }, { title: "b" }] },
        }),
      ),
    ).toBe("2 action items")
    expect(
      describeAnalysisRow(
        makeAnalysis({ analysisType: "action_items", output: { kind: "action_items", items: [] } }),
      ),
    ).toBe("0 action items")
    expect(
      describeAnalysisRow(
        makeAnalysis({
          analysisType: "key_topics",
          output: { kind: "key_topics", topics: [{ topic: "Renewal" }] },
        }),
      ),
    ).toBe("Renewal")
    expect(
      describeAnalysisRow(
        makeAnalysis({
          analysisType: "sentiment",
          output: { kind: "sentiment", label: "negative" },
        }),
      ),
    ).toBe("Sentiment: negative")
  })

  test("a bad timestamp renders as nothing, never as Invalid Date", () => {
    expect(formatConversationTimestamp(null)).toBe("")
    expect(formatConversationTimestamp("")).toBe("")
    expect(formatConversationTimestamp("not-a-date")).toBe("")
    expect(formatConversationTimestamp("2026-09-20T10:00:00.000Z")).not.toBe("")
  })
})
