import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import { aiConversations, aiMessages, aiRuns, type AiConversation } from "../schema/ai"
import {
  createAiRepository,
  normalizeAiConversationTitle,
  toAiMessageValues,
  toAiRunValues,
  validateAiMessageRole,
  validateAiRunOutcome,
} from "./ai-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const CONVERSATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const RUN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const MIGRATION = new URL("../../migrations/0340_ai.sql", import.meta.url)

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

function makeConversation(overrides: Partial<AiConversation> = {}): AiConversation {
  return {
    id: CONVERSATION_ID,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    userId: USER_ID,
    title: "How many deals closed?",
    model: null,
    lastMessageAt: null,
    ...overrides,
  }
}

describe("ai/schema", () => {
  test("all three tables expose the BaseRecord column contract", () => {
    for (const table of [aiConversations, aiMessages, aiRuns]) {
      const cols = table as unknown as Record<string, unknown>
      for (const col of ["id", "workspaceId", "createdAt", "updatedAt", "deletedAt"]) {
        expect(cols[col], col).toBeDefined()
      }
    }
  })

  test("messages carry attribution columns (model, provider, run)", () => {
    const cols = aiMessages as unknown as Record<string, unknown>
    expect(cols.conversationId).toBeDefined()
    expect(cols.role).toBeDefined()
    expect(cols.model).toBeDefined()
    expect(cols.providerId).toBeDefined()
    expect(cols.runId).toBeDefined()
    expect(cols.toolCalls).toBeDefined()
    expect(cols.toolCallId).toBeDefined()
  })

  test("runs carry the accounting columns spec 38 reads", () => {
    const cols = aiRuns as unknown as Record<string, unknown>
    for (const col of [
      "model",
      "providerId",
      "promptTokens",
      "completionTokens",
      "totalTokens",
      "latencyMs",
      "costMicros",
      "outcome",
      "toolCallCount",
      "correlationId",
    ]) {
      expect(cols[col], col).toBeDefined()
    }
  })
})

describe("ai/migration", () => {
  test("0340_ai creates the three tables with their guards", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS ai_conversations")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS ai_messages")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS ai_runs")
    expect(sql).toContain("REFERENCES ai_conversations (id) ON DELETE CASCADE")
    expect(sql).toContain("ai_messages_role_chk")
    expect(sql).toContain("ai_runs_outcome_chk")
    expect(sql).toContain("cost_micros BIGINT")
  })

  test("no foreign key points at a table this module does not own", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const references = [...sql.matchAll(/REFERENCES\s+(\w+)/gi)].map((match) => match[1])
    expect(new Set(references)).toEqual(new Set(["ai_conversations"]))
  })
})

describe("ai/validation", () => {
  test("titles trim, collapse whitespace and are bounded", () => {
    expect(normalizeAiConversationTitle("  How   many  deals? ")).toBe("How many deals?")
    expect(normalizeAiConversationTitle("x".repeat(400))).toHaveLength(255)
    expect(() => normalizeAiConversationTitle("   ")).toThrow()
  })

  test("roles and outcomes are allowlisted", () => {
    expect(validateAiMessageRole("tool")).toBe("tool")
    expect(() => validateAiMessageRole("root")).toThrow(/system, user, assistant, tool/)
    expect(validateAiRunOutcome("denied")).toBe("denied")
    expect(() => validateAiRunOutcome("maybe")).toThrow(/succeeded, failed, denied/)
  })

  test("run counters are rounded and must be non-negative", () => {
    const base = {
      id: RUN_ID,
      conversationId: CONVERSATION_ID,
      providerId: "openai-compatible",
      model: "deepseek-v4-flash",
      promptTokens: 10.4,
      completionTokens: 2,
      totalTokens: 12,
      latencyMs: 1234.6,
      outcome: "succeeded",
      toolCallCount: 1,
    }
    const values = toAiRunValues(WS, base, USER_ID)
    expect(values.promptTokens).toBe(10)
    expect(values.latencyMs).toBe(1235)
    expect(values.actorId).toBe(USER_ID)
    expect(values.costMicros).toBeNull()
    expect(() => toAiRunValues(WS, { ...base, promptTokens: -1 }, USER_ID)).toThrow()
  })

  test("message values default every optional attribution column to null", () => {
    const values = toAiMessageValues(WS, {
      conversationId: CONVERSATION_ID,
      role: "user",
      content: "hi",
    })
    expect(values).toMatchObject({
      workspaceId: WS,
      conversationId: CONVERSATION_ID,
      role: "user",
      content: "hi",
      model: null,
      providerId: null,
      runId: null,
      toolCalls: null,
    })
  })
})

describe("ai/repository", () => {
  test("createConversation returns the inserted row", async () => {
    const row = makeConversation()
    const created = await createAiRepository().createConversation(
      mockDb([[row]]),
      WS,
      { title: "How many deals closed?" },
      USER_ID,
    )
    expect(created).toBe(row)
  })

  test("createConversation surfaces an empty insert as an error", async () => {
    await expect(
      createAiRepository().createConversation(mockDb([[]]), WS, { title: "x" }, USER_ID),
    ).rejects.toThrow("insert returned no row")
  })

  test("listConversations returns the pagination envelope", async () => {
    const result = await createAiRepository().listConversations(mockDb([[makeConversation()]]), {
      workspaceId: WS,
      scope: { kind: "own", actorId: USER_ID },
      limit: 25,
    })
    expect(result.data).toHaveLength(1)
    expect(result.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("recordRun rejects an unknown outcome before touching the db", async () => {
    await expect(
      createAiRepository().recordRun(mockDb(), WS, {
        id: RUN_ID,
        conversationId: CONVERSATION_ID,
        providerId: "stub",
        model: "stub-echo-1",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        latencyMs: 1,
        outcome: "exploded",
        toolCallCount: 0,
      }),
    ).rejects.toThrow(/succeeded, failed, denied/)
  })
})
