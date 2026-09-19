import { afterEach, describe, expect, test } from "bun:test"
import {
  conversationAnalysisJobPayloadSchema,
  registerConversationAnalysisRunner,
  resetConversationAnalysisRunner,
  runConversationAnalysisJob,
  ConversationAnalysisRunnerNotBoundError,
  CONVERSATION_ANALYSIS_JOB_NAME,
} from "./conversation-intelligence"
import { JobHandlers } from "../worker"

/**
 * The transport half of "analysis is on-demand or queued, never inline in
 * a request". Nothing here talks to Redis: the handler is a pure function
 * of its validated input plus an injected runner.
 */

const PAYLOAD = {
  workspaceId: "ws_1",
  analysisId: "an_1",
  subjectType: "email_thread",
  subjectId: "thread_1",
  analysisType: "summary",
  actorId: "u_1",
  correlationId: "corr_1",
}

afterEach(() => {
  resetConversationAnalysisRunner()
})

describe("worker/conversation-intelligence", () => {
  test("the handler is registered under its job name", () => {
    expect(JobHandlers[CONVERSATION_ANALYSIS_JOB_NAME]).toBe(runConversationAnalysisJob)
  })

  test("an unbound runner dead-letters loudly instead of dropping the analysis", async () => {
    await expect(runConversationAnalysisJob(PAYLOAD)).rejects.toBeInstanceOf(
      ConversationAnalysisRunnerNotBoundError,
    )
  })

  test("a bound runner receives the validated payload", async () => {
    const seen: unknown[] = []
    registerConversationAnalysisRunner(async (payload) => {
      seen.push(payload)
      return { analysisId: payload.analysisId, status: "succeeded", totalTokens: 1_234 }
    })
    const result = await runConversationAnalysisJob(PAYLOAD)
    expect(result).toEqual({ analysisId: "an_1", status: "succeeded", totalTokens: 1_234 })
    expect(seen[0]).toMatchObject({ analysisId: "an_1", actorId: "u_1" })
  })

  test("the payload carries ids and an actor — never a role, never text", () => {
    const parsed = conversationAnalysisJobPayloadSchema.parse(PAYLOAD)
    expect(Object.keys(parsed).sort()).toEqual([
      "actorId",
      "analysisId",
      "analysisType",
      "correlationId",
      "subjectId",
      "subjectType",
      "workspaceId",
    ])
    // A hand-crafted payload cannot smuggle a role, a prompt or a bigger
    // budget past the domain service: those fields do not exist.
    const extra = conversationAnalysisJobPayloadSchema.parse({
      ...PAYLOAD,
      role: "owner",
      text: "pretend transcript",
      maxSourceChars: 10_000_000,
    })
    expect(extra).not.toHaveProperty("role")
    expect(extra).not.toHaveProperty("text")
    expect(extra).not.toHaveProperty("maxSourceChars")
  })

  test("an invalid payload is rejected at run time, not just at enqueue", async () => {
    registerConversationAnalysisRunner(async () => ({
      analysisId: "x",
      status: "succeeded",
      totalTokens: 0,
    }))
    await expect(
      runConversationAnalysisJob({ ...PAYLOAD, analysisType: "vibes" }),
    ).rejects.toThrow()
    await expect(runConversationAnalysisJob({ ...PAYLOAD, actorId: "" })).rejects.toThrow()
  })
})
