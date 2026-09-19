import { describe, expect, test } from "bun:test"
import {
  boundConversationSource,
  boundConversationText,
  conversationSourceToText,
  estimateConversationTokens,
  formatConversationTurn,
  CONVERSATION_ANALYSIS_MAX_SOURCE_CHARS,
} from "./bounds"
import type { ConversationSource, ConversationTurn } from "./types"

/**
 * PROPERTY 3 — BOUNDED COST, at the level of the pure function that
 * decides it. The service-level proof (an enormous transcript produces a
 * bounded provider request) lives in `service.test.ts`; this file proves
 * the arithmetic underneath it, including the cases a service test would
 * never reach.
 */

function makeTurns(count: number, chars: number): ConversationTurn[] {
  return Array.from({ length: count }, (_, index) => ({
    speaker: `Speaker ${String(index % 2)}`,
    at: `2026-09-20T10:${String(index % 60).padStart(2, "0")}:00.000Z`,
    text: "x".repeat(chars),
  }))
}

function makeSource(turns: ConversationTurn[]): ConversationSource {
  return {
    subjectType: "call",
    subjectId: "call_1",
    title: "Quarterly review",
    turns,
    participants: ["Speaker 0", "Speaker 1"],
    occurredAt: "2026-09-20T10:00:00.000Z",
  }
}

describe("conversation-intelligence/bounds", () => {
  test("short conversations pass through untouched", () => {
    const bounded = boundConversationText("hello there")
    expect(bounded.text).toBe("hello there")
    expect(bounded.truncated).toBe(false)
    expect(bounded.omittedChars).toBe(0)
    expect(bounded.sourceChars).toBe(11)
    expect(bounded.analysedChars).toBe(11)
  })

  test("text exactly at the cap is not truncated", () => {
    const text = "y".repeat(CONVERSATION_ANALYSIS_MAX_SOURCE_CHARS)
    const bounded = boundConversationText(text)
    expect(bounded.truncated).toBe(false)
    expect(bounded.analysedChars).toBe(CONVERSATION_ANALYSIS_MAX_SOURCE_CHARS)
  })

  test("bounded cost/an enormous transcript never exceeds the cap", () => {
    // Two million characters — a full working day of speech.
    const bounded = boundConversationText("z".repeat(2_000_000))
    expect(bounded.sourceChars).toBe(2_000_000)
    expect(bounded.truncated).toBe(true)
    expect(bounded.analysedChars).toBeLessThanOrEqual(CONVERSATION_ANALYSIS_MAX_SOURCE_CHARS)
    expect(bounded.text.length).toBe(bounded.analysedChars)
    expect(bounded.omittedChars).toBeGreaterThan(1_900_000)
  })

  test("the cap holds for every size, not just the big ones", () => {
    for (const size of [1, 99, 512, 4_096, 25_000, 100_000, 999_999]) {
      for (const cap of [64, 512, 5_000, CONVERSATION_ANALYSIS_MAX_SOURCE_CHARS]) {
        const bounded = boundConversationText("q".repeat(size), cap)
        expect(bounded.analysedChars).toBeLessThanOrEqual(cap)
        expect(bounded.truncated).toBe(size > cap)
      }
    }
  })

  test("truncation keeps the opening AND the ending, not just the opening", () => {
    const text = `OPENING-MARKER\n${"m".repeat(60_000)}\nCLOSING-MARKER`
    const bounded = boundConversationText(text)
    expect(bounded.text.startsWith("OPENING-MARKER")).toBe(true)
    expect(bounded.text.endsWith("CLOSING-MARKER")).toBe(true)
    expect(bounded.text).toContain("characters omitted from the middle")
  })

  test("truncation is deterministic — identical input, identical bytes", () => {
    const text = makeTurns(400, 500).map(formatConversationTurn).join("\n\n")
    const first = boundConversationText(text)
    const second = boundConversationText(text)
    expect(first.text).toBe(second.text)
    expect(first.omittedChars).toBe(second.omittedChars)
    expect(first.analysedChars).toBe(second.analysedChars)
  })

  test("the omission marker reports how much was dropped", () => {
    const bounded = boundConversationText("w".repeat(120_000))
    expect(bounded.text).toContain(`[… ${String(bounded.omittedChars)} characters omitted`)
    expect(bounded.omittedChars).toBe(
      bounded.sourceChars - (bounded.analysedChars - markerLength(bounded.text)),
    )
  })

  test("a pathologically small cap still returns something within it", () => {
    const bounded = boundConversationText("a".repeat(5_000), 20)
    expect(bounded.analysedChars).toBeLessThanOrEqual(20)
    expect(bounded.truncated).toBe(true)
  })

  test("a single enormous turn is cut before it reaches the joiner", () => {
    const line = formatConversationTurn({ speaker: "Ada", at: null, text: "b".repeat(50_000) })
    expect(line.length).toBeLessThan(5_000)
    expect(line).toContain("[turn truncated]")
  })

  test("turns render oldest-first with speaker attribution", () => {
    const text = conversationSourceToText(
      makeSource([
        { speaker: "Ada", at: null, text: "Can we move the date?" },
        { speaker: "Grace", at: null, text: "Yes, the 4th works." },
      ]),
    )
    expect(text).toBe("Ada: Can we move the date?\n\nGrace: Yes, the 4th works.")
  })

  test("blank turns do not become blank lines in the prompt", () => {
    const text = conversationSourceToText(
      makeSource([
        { speaker: "Ada", at: null, text: "Hello" },
        { speaker: "Grace", at: null, text: "   " },
      ]),
    )
    expect(text).toBe("Ada: Hello")
  })

  test("bounding a source reports the full conversation size", () => {
    const source = makeSource(makeTurns(200, 1_000))
    const bounded = boundConversationSource(source)
    expect(bounded.sourceChars).toBeGreaterThan(200_000)
    expect(bounded.analysedChars).toBeLessThanOrEqual(CONVERSATION_ANALYSIS_MAX_SOURCE_CHARS)
    expect(bounded.truncated).toBe(true)
  })

  test("the documented token estimate matches the cap we advertise", () => {
    expect(estimateConversationTokens(CONVERSATION_ANALYSIS_MAX_SOURCE_CHARS)).toBe(6_000)
  })
})

/** Length of the omission marker inside an already-bounded string. */
function markerLength(text: string): number {
  const start = text.indexOf("[… ")
  const end = text.indexOf("…]", start)
  return start === -1 || end === -1 ? 0 : end + 2 - start + 4
}
