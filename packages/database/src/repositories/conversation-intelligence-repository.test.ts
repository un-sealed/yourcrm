import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import { callTranscripts, conversationAnalyses } from "../schema/conversation-intelligence"
import {
  toCallTranscriptValues,
  toConversationAnalysisValues,
  validateCallTranscriptSource,
  validateConversationAnalysisStatus,
  validateConversationAnalysisType,
  validateConversationSubjectType,
} from "./conversation-intelligence-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const SUBJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const RUN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const MIGRATION = new URL("../../migrations/0410_conversation_intelligence.sql", import.meta.url)

describe("conversation-intelligence/schema", () => {
  test("both tables expose the BaseRecord column contract", () => {
    for (const table of [conversationAnalyses, callTranscripts]) {
      const cols = table as unknown as Record<string, unknown>
      for (const col of ["id", "workspaceId", "createdAt", "updatedAt", "deletedAt"]) {
        expect(cols[col], col).toBeDefined()
      }
    }
  })

  test("an analysis carries full attribution AND its cost facts", () => {
    const cols = conversationAnalyses as unknown as Record<string, unknown>
    for (const col of [
      "subjectType",
      "subjectId",
      "analysisType",
      "status",
      "providerId",
      "model",
      "runId",
      "output",
      "promptTokens",
      "completionTokens",
      "totalTokens",
      "latencyMs",
      "sourceChars",
      "analysedChars",
      "truncated",
      "requestedBy",
      "analysedAt",
      "errorCode",
      "correlationId",
    ]) {
      expect(cols[col], col).toBeDefined()
    }
  })

  test("a transcript records where it came from, for the STT seam", () => {
    const cols = callTranscripts as unknown as Record<string, unknown>
    for (const col of [
      "source",
      "providerId",
      "externalId",
      "language",
      "text",
      "segments",
      "durationMs",
      "speakerCount",
      "charCount",
    ]) {
      expect(cols[col], col).toBeDefined()
    }
  })
})

describe("conversation-intelligence/migration", () => {
  test("0410 creates both tables with their guards", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS conversation_analyses")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS call_transcripts")
    expect(sql).toContain("conversation_analyses_subject_type_chk")
    expect(sql).toContain("conversation_analyses_type_chk")
    expect(sql).toContain("conversation_analyses_status_chk")
    expect(sql).toContain("call_transcripts_source_chk")
  })

  test("provider re-delivery is idempotent by a unique index, not by hope", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS call_transcripts_external_idx")
    expect(sql).toContain("WHERE external_id IS NOT NULL")
  })

  test("no foreign key points at a table this module does not own", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    // `subject_id` names an email thread, a WhatsApp conversation or a
    // call — all owned elsewhere — so it is a plain uuid by design.
    expect([...sql.matchAll(/REFERENCES\s+(\w+)/gi)]).toEqual([])
    expect(sql).toContain("subject_id UUID NOT NULL")
  })

  test("the migration says where speech-to-text would plug in", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("THE SPEECH-TO-TEXT SEAM")
  })
})

describe("conversation-intelligence/validation", () => {
  test("every vocabulary is allowlisted at the repository, not just in zod", () => {
    expect(validateConversationSubjectType("call")).toBe("call")
    expect(() => validateConversationSubjectType("telepathy")).toThrow(/email_thread/)
    expect(validateConversationAnalysisType("key_topics")).toBe("key_topics")
    expect(() => validateConversationAnalysisType("vibes")).toThrow(/summary/)
    expect(validateConversationAnalysisStatus("queued")).toBe("queued")
    expect(() => validateConversationAnalysisStatus("pending")).toThrow(/succeeded/)
    expect(validateCallTranscriptSource("manual")).toBe("manual")
    expect(() => validateCallTranscriptSource("psychic")).toThrow(/provider or manual/)
  })

  test("an analysis row defaults to queued with zeroed accounting", () => {
    const values = toConversationAnalysisValues(
      WS,
      { subjectType: "email_thread", subjectId: SUBJECT, analysisType: "summary" },
      USER,
    )
    expect(values).toMatchObject({
      workspaceId: WS,
      status: "queued",
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      sourceChars: 0,
      analysedChars: 0,
      truncated: false,
      requestedBy: USER,
      createdBy: USER,
    })
  })

  test("token and character counters are rounded and must be non-negative", () => {
    const values = toConversationAnalysisValues(WS, {
      subjectType: "call",
      subjectId: SUBJECT,
      analysisType: "sentiment",
      status: "succeeded",
      runId: RUN,
      promptTokens: 5_911.6,
      completionTokens: 44,
      totalTokens: 5_956,
      latencyMs: 812.4,
      sourceChars: 1_800_000,
      analysedChars: 24_000,
      truncated: true,
    })
    expect(values).toMatchObject({
      promptTokens: 5_912,
      latencyMs: 812,
      sourceChars: 1_800_000,
      analysedChars: 24_000,
      truncated: true,
      runId: RUN,
    })
    expect(() =>
      toConversationAnalysisValues(WS, {
        subjectType: "call",
        subjectId: SUBJECT,
        analysisType: "summary",
        promptTokens: -1,
      }),
    ).toThrow(/non-negative/)
  })

  test("a transcript defaults to the call subject and counts its own characters", () => {
    const values = toCallTranscriptValues(
      WS,
      { subjectId: SUBJECT, source: "manual", text: "Ada: hello\nGrace: hi" },
      USER,
    )
    expect(values).toMatchObject({
      subjectType: "call",
      source: "manual",
      providerId: null,
      externalId: null,
      charCount: 20,
      speakerCount: 0,
      createdBy: USER,
    })
  })
})
