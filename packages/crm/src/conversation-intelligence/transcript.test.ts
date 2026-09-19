import { describe, expect, test } from "bun:test"
import {
  callTranscriptSpeakers,
  callTranscriptTextFromSegments,
  callTranscriptToConversationTurns,
  formatTranscriptOffset,
  normalizeCallTranscriptSegments,
  CALL_TRANSCRIPT_MAX_SEGMENTS,
  CALL_TRANSCRIPT_MAX_SEGMENT_CHARS,
} from "./transcript"
import type { CallTranscriptRecord } from "./types"

/**
 * The speech-to-text SEAM, tested from the shape a provider payload
 * arrives in. There is no audio here and no transcription — see the
 * header of `transcript.ts` for why, and for what wiring a real STT
 * provider would consist of.
 */

function makeTranscript(overrides: Partial<CallTranscriptRecord> = {}): CallTranscriptRecord {
  return {
    id: "tr_1",
    workspaceId: "ws_1",
    subjectType: "call",
    subjectId: "call_1",
    text: "",
    ...overrides,
  }
}

describe("conversation-intelligence/transcript", () => {
  test("a provider payload becomes normalised segments", () => {
    const segments = normalizeCallTranscriptSegments([
      { speaker: "Ada", startMs: 0, endMs: 2400, text: " Good morning. " },
      { speakerLabel: "Grace", start_ms: "2400", end_ms: 5100, content: "Morning!" },
    ])
    expect(segments).toEqual([
      { speaker: "Ada", startMs: 0, endMs: 2400, text: "Good morning." },
      { speaker: "Grace", startMs: 2400, endMs: 5100, text: "Morning!" },
    ])
  })

  test("an unrecognised entry is dropped, never thrown — this runs in a webhook", () => {
    expect(normalizeCallTranscriptSegments([null, 7, "x", { text: "" }, {}])).toEqual([])
    expect(normalizeCallTranscriptSegments("not an array")).toEqual([])
    expect(normalizeCallTranscriptSegments(undefined)).toEqual([])
  })

  test("a segment with no speaker is labelled, not silently attributed", () => {
    const segments = normalizeCallTranscriptSegments([{ text: "…and that's agreed." }])
    expect(segments[0]?.speaker).toBe("Unknown speaker")
    expect(segments[0]?.startMs).toBeNull()
  })

  test("an oversized payload is truncated rather than rejected", () => {
    const huge = Array.from({ length: CALL_TRANSCRIPT_MAX_SEGMENTS + 500 }, () => ({
      speaker: "Ada",
      text: "z".repeat(CALL_TRANSCRIPT_MAX_SEGMENT_CHARS + 100),
    }))
    const segments = normalizeCallTranscriptSegments(huge)
    expect(segments.length).toBe(CALL_TRANSCRIPT_MAX_SEGMENTS)
    expect(segments[0]?.text.length).toBe(CALL_TRANSCRIPT_MAX_SEGMENT_CHARS)
  })

  test("speaker identification is carried through, never inferred", () => {
    const segments = normalizeCallTranscriptSegments([
      { speaker: "Ada", text: "one" },
      { speaker: "Grace", text: "two" },
      { speaker: "Ada", text: "three" },
    ])
    expect(callTranscriptSpeakers(segments)).toEqual(["Ada", "Grace"])
    expect(callTranscriptTextFromSegments(segments)).toBe("Ada: one\nGrace: two\nAda: three")
  })

  test("offsets render as clock time for the UI", () => {
    expect(formatTranscriptOffset(0)).toBe("00:00:00")
    expect(formatTranscriptOffset(3_723_000)).toBe("01:02:03")
    expect(formatTranscriptOffset(null)).toBe("")
  })

  test("a segmented transcript becomes speaker-attributed turns", () => {
    const turns = callTranscriptToConversationTurns(
      makeTranscript({
        text: "ignored when segments exist",
        segments: [
          { speaker: "Ada", startMs: 0, text: "Shall we sign?" },
          { speaker: "Grace", startMs: 61_000, text: "Send it over." },
        ],
      }),
    )
    expect(turns).toEqual([
      { speaker: "Ada", at: "00:00:00", text: "Shall we sign?" },
      { speaker: "Grace", at: "00:01:01", text: "Send it over." },
    ])
  })

  test("a pasted wall of text still yields turns where it can", () => {
    const turns = callTranscriptToConversationTurns(
      makeTranscript({ text: "Ada: Shall we sign?\nGrace: Send it over.\nunattributed line" }),
    )
    expect(turns).toEqual([
      { speaker: "Ada", at: null, text: "Shall we sign?" },
      { speaker: "Grace", at: null, text: "Send it over." },
      { speaker: "Unknown speaker", at: null, text: "unattributed line" },
    ])
  })

  test("an empty transcript yields no turns rather than a blank one", () => {
    expect(callTranscriptToConversationTurns(makeTranscript({ text: "  \n \n" }))).toEqual([])
  })
})
