import { describe, expect, test } from "bun:test"
import { boundConversationSource } from "./bounds"
import {
  buildConversationAnalysisMessages,
  buildConversationAnalysisSystemPrompt,
  conversationActionItemsOf,
  extractJsonObject,
  parseConversationAnalysisOutput,
  CONVERSATION_SENTIMENT_CAVEAT,
} from "./prompt"
import type { ConversationSource } from "./types"

const SOURCE: ConversationSource = {
  subjectType: "email_thread",
  subjectId: "thread_1",
  title: "Renewal for Northwind",
  turns: [
    { speaker: "Ada", at: "2026-09-18T09:00:00.000Z", text: "Can you resend the quote?" },
    { speaker: "Grace", at: "2026-09-18T09:20:00.000Z", text: "Sent — I'll call Friday." },
  ],
  participants: ["Ada", "Grace"],
  occurredAt: "2026-09-18T09:00:00.000Z",
}

describe("conversation-intelligence/prompt", () => {
  test("the system prompt forbids inventing and forbids acting", () => {
    const prompt = buildConversationAnalysisSystemPrompt("summary")
    expect(prompt).toContain("never guess")
    expect(prompt).toContain("You cannot take actions")
    expect(prompt).toContain("JSON")
  })

  test("a request is exactly two messages: instructions and one conversation", () => {
    const bounded = boundConversationSource(SOURCE)
    const messages = buildConversationAnalysisMessages({
      analysisType: "summary",
      source: SOURCE,
      bounded,
    })
    expect(messages.length).toBe(2)
    expect(messages[0]?.role).toBe("system")
    expect(messages[1]?.role).toBe("user")
    expect(messages[1]?.content).toContain("Renewal for Northwind")
    expect(messages[1]?.content).toContain("Can you resend the quote?")
  })

  test("a truncated conversation tells the model it was truncated", () => {
    const long: ConversationSource = {
      ...SOURCE,
      turns: Array.from({ length: 400 }, (_, i) => ({
        speaker: `S${String(i % 2)}`,
        at: null,
        text: "u".repeat(400),
      })),
    }
    const bounded = boundConversationSource(long)
    const messages = buildConversationAnalysisMessages({
      analysisType: "summary",
      source: long,
      bounded,
    })
    expect(messages[1]?.content).toContain("were removed from the middle")
  })

  test("summary JSON parses into a summary plus highlights", () => {
    const output = parseConversationAnalysisOutput(
      "summary",
      '```json\n{"summary":"Ada asked for the quote.","highlights":["Quote resent","Call on Friday"]}\n```',
    )
    expect(output).toEqual({
      kind: "summary",
      summary: "Ada asked for the quote.",
      highlights: ["Quote resent", "Call on Friday"],
    })
  })

  test("a prose reply still produces a usable summary rather than a failed run", () => {
    const output = parseConversationAnalysisOutput("summary", "Ada asked for the quote again.")
    expect(output).toEqual({
      kind: "summary",
      summary: "Ada asked for the quote again.",
      highlights: [],
    })
  })

  test("sentiment always carries the caveat, whatever the model said", () => {
    const parsed = parseConversationAnalysisOutput(
      "sentiment",
      '{"label":"POSITIVE","score":0.8,"rationale":"Cooperative throughout."}',
    )
    expect(parsed).toEqual({
      kind: "sentiment",
      label: "positive",
      score: 0.8,
      rationale: "Cooperative throughout.",
      caveat: CONVERSATION_SENTIMENT_CAVEAT,
    })
    const fallback = parseConversationAnalysisOutput("sentiment", "I could not tell.")
    expect(fallback).toMatchObject({ label: "neutral", score: null })
    expect((fallback as { caveat: string }).caveat).toBe(CONVERSATION_SENTIMENT_CAVEAT)
  })

  test("a sentiment score outside [-1, 1] is clamped, not stored raw", () => {
    const parsed = parseConversationAnalysisOutput("sentiment", '{"label":"negative","score":-42}')
    expect(parsed).toMatchObject({ score: -1 })
  })

  test("action items parse with owner and due date, and null when absent", () => {
    const parsed = parseConversationAnalysisOutput(
      "action_items",
      '{"items":[{"title":"Resend the quote","owner":"Grace","dueDate":"2026-09-19"},"Call Ada on Friday"]}',
    )
    expect(parsed).toEqual({
      kind: "action_items",
      items: [
        { title: "Resend the quote", owner: "Grace", dueDate: "2026-09-19" },
        { title: "Call Ada on Friday", owner: null, dueDate: null },
      ],
    })
  })

  test("an empty action-item list is a correct answer, not a parse failure", () => {
    expect(parseConversationAnalysisOutput("action_items", '{"items":[]}')).toEqual({
      kind: "action_items",
      items: [],
    })
  })

  test("a runaway model cannot write unbounded rows into the output column", () => {
    const many = JSON.stringify({
      items: Array.from({ length: 500 }, (_, i) => ({ title: `t${String(i)}`.repeat(400) })),
    })
    const parsed = parseConversationAnalysisOutput("action_items", many)
    const items = (parsed as { items: { title: string }[] }).items
    expect(items.length).toBe(25)
    expect(items[0]?.title.length).toBeLessThanOrEqual(300)
  })

  test("key topics parse with mention counts", () => {
    expect(
      parseConversationAnalysisOutput(
        "key_topics",
        '{"topics":[{"topic":"Renewal","mentions":3},"Pricing"]}',
      ),
    ).toEqual({
      kind: "key_topics",
      topics: [
        { topic: "Renewal", mentions: 3 },
        { topic: "Pricing", mentions: null },
      ],
    })
  })

  test("extractJsonObject survives fences, prose and malformed JSON", () => {
    expect(extractJsonObject('here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJsonObject("no object here")).toBeNull()
    expect(extractJsonObject("{not json}")).toBeNull()
  })

  test("action items are only read back from an action-item output", () => {
    const items = conversationActionItemsOf({
      kind: "action_items",
      items: [{ title: "Call Ada", owner: null, dueDate: null }],
    })
    expect(items.length).toBe(1)
    expect(conversationActionItemsOf({ kind: "summary", summary: "x" })).toEqual([])
    expect(conversationActionItemsOf(null)).toEqual([])
    expect(conversationActionItemsOf("items")).toEqual([])
  })
})
