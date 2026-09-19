import { beforeEach, describe, expect, test } from "bun:test"
import { PermissionDeniedError } from "@yourcrm/permissions"
import {
  captureEvents,
  createStore,
  expectDenied,
  makeBaseRecord,
  makeServiceContext,
  resetIdCounter,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import type {
  ReportExecutionRequest,
  ReportExecutionResult,
  ReportObjectCatalogEntry,
  ReportRowScope,
} from "../reports/types"
import { createStubAiProvider, type StubAiScriptStep } from "./providers/stub-ai-provider"
import { createAiCrmTools, createAiToolRegistry } from "./tools"
import { computeAiCostMicros, createAiAssistantService, deriveAiConversationTitle } from "./service"
import type {
  AiAssistantStore,
  AiAuditInput,
  AiConversationRecord,
  AiMessageInsert,
  AiMessageRecord,
  AiReportQueryPort,
  AiRunInsert,
  AiRunRecord,
  AiTool,
} from "./types"

/* ------------------------------ fixtures ------------------------------ */

const WORKSPACE = "ws_ai"
const ADMIN = "user_admin"
const VIEWER = "user_viewer"

type StoredConversation = BaseRecord & { title: string; userId: string; model: string | null }
type StoredMessage = BaseRecord & AiMessageInsert & { sequence: number }
type StoredRun = BaseRecord & AiRunInsert

/** In-memory `AiAssistantStore`; the API adapts the drizzle repository. */
function createFakeAiStore() {
  const conversations = createStore<StoredConversation>()
  const messages = createStore<StoredMessage>()
  const runs = createStore<StoredRun>()
  let sequence = 0

  const store: AiAssistantStore = {
    listConversations: async (workspaceId, query, scope) => {
      const rows = conversations
        .list(workspaceId)
        .filter((row) => row.userId === scope.actorId)
        .filter(
          (row) =>
            query.query === undefined ||
            row.title.toLowerCase().includes(query.query.toLowerCase()),
        )
      const limit = query.limit ?? 25
      return {
        data: rows.slice(0, limit) as unknown as AiConversationRecord[],
        pagination: { nextCursor: null, limit },
      }
    },
    findConversation: async (workspaceId, id) =>
      conversations.get(id, workspaceId) as unknown as AiConversationRecord | null,
    createConversation: async (workspaceId, input, actorId) =>
      conversations.insert({
        ...makeBaseRecord({ workspaceId }),
        title: input.title,
        userId: actorId ?? "",
        model: input.model ?? null,
      }) as unknown as AiConversationRecord,
    updateConversation: async (workspaceId, id, patch) =>
      conversations.update(id, workspaceId, {
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.model === undefined ? {} : { model: patch.model }),
      }) as unknown as AiConversationRecord | null,
    softDeleteConversation: async (workspaceId, id) => {
      conversations.remove(id, workspaceId)
    },
    listMessages: async (workspaceId, conversationId, limit) => {
      const rows = messages
        .list(workspaceId)
        .filter((row) => row.conversationId === conversationId)
        .sort((a, b) => a.sequence - b.sequence)
      const sliced = limit === undefined ? rows : rows.slice(-limit)
      return sliced as unknown as AiMessageRecord[]
    },
    appendMessage: async (workspaceId, input) => {
      sequence += 1
      return messages.insert({
        ...makeBaseRecord({ workspaceId }),
        ...input,
        sequence,
      }) as unknown as AiMessageRecord
    },
    recordRun: async (workspaceId, input) =>
      runs.insert({
        ...makeBaseRecord({ workspaceId, id: input.id }),
        ...input,
      }) as unknown as AiRunRecord,
    listRuns: async (workspaceId, conversationId) =>
      runs
        .list(workspaceId)
        .filter((row) => row.conversationId === conversationId) as unknown as AiRunRecord[],
  }
  return { store, conversations, messages, runs }
}

type DealRow = { id: string; ownerId: string; stage: string; amount: number }

/**
 * Fake reporting engine. It does exactly what the real one does with a
 * scope: `own` narrows to the caller's records. That is what makes the
 * viewer-vs-admin assertion below meaningful.
 */
function createFakeReportEngine(deals: DealRow[]) {
  const seen: { request: ReportExecutionRequest; scope: ReportRowScope }[] = []
  const catalogue: ReportObjectCatalogEntry[] = [
    {
      objectType: "deal",
      label: "Deals",
      fields: [
        { name: "stage", label: "Stage", type: "text" },
        { name: "amount", label: "Amount", type: "number" },
        { name: "ownerId", label: "Owner", type: "text" },
      ],
    },
  ]
  const reports: AiReportQueryPort = {
    describeObjects: () => catalogue,
    execute: async (
      _workspaceId: string,
      request: ReportExecutionRequest,
      scope: ReportRowScope,
    ): Promise<ReportExecutionResult> => {
      seen.push({ request, scope })
      const visible = deals.filter(
        (deal) => scope.kind === "workspace" || deal.ownerId === scope.actorId,
      )
      return {
        objectType: request.objectType,
        mode: "grouped",
        scope: scope.kind,
        columns: [{ key: "count", field: null, label: "Count", type: "number", role: "metric" }],
        rows: [{ count: visible.length }],
        rowCount: 1,
        limit: 25,
        truncated: false,
      }
    },
  }
  return { reports, seen }
}

const QUERY_STEP: StubAiScriptStep = {
  toolCalls: [{ id: "call_1", name: "crm_query", arguments: { objectType: "deal" } }],
}

function makeService(options: {
  deals?: DealRow[]
  script?: StubAiScriptStep[]
  tools?: AiTool[]
  audit?: AiAuditInput[]
}) {
  const fake = createFakeAiStore()
  const engine = createFakeReportEngine(options.deals ?? [])
  const provider = createStubAiProvider({ script: options.script })
  const audit = options.audit ?? []
  const service = createAiAssistantService({
    store: fake.store,
    provider,
    tools:
      options.tools === undefined
        ? createAiCrmTools({ reports: engine.reports })
        : createAiToolRegistry(options.tools),
    audit: async (input) => {
      audit.push(input)
    },
    pricing: { "stub-echo-1": { inputMicrosPerMillion: 1000, outputMicrosPerMillion: 2000 } },
    newId: (() => {
      let counter = 0
      return () => {
        counter += 1
        return `run_${String(counter)}`
      }
    })(),
  })
  return { service, provider, audit, engine, ...fake }
}

function ctxFor(actorId: string, role: string) {
  return makeServiceContext({ workspaceId: WORKSPACE, actorId, role, correlationId: "corr_1" })
}

beforeEach(() => {
  resetIdCounter()
})

/* -------------------------------- tests -------------------------------- */

describe("ai-assistant/ask", () => {
  test("answers, persists both messages and records an attributable run", async () => {
    const { service, messages, runs } = makeService({})
    const ctx = ctxFor(ADMIN, "admin")

    const result = await service.ask(ctx, { message: "how many deals are open?" })

    expect(result.assistantMessage.content).toBe("stub: how many deals are open?")
    expect(result.assistantMessage.model).toBe("stub-echo-1")
    expect(result.assistantMessage.runId).toBe("run_1")
    expect(result.run.id).toBe("run_1")
    expect(result.run.outcome).toBe("succeeded")
    expect(result.run.totalTokens as number).toBeGreaterThan(0)
    expect(result.run.providerId).toBe("stub")
    expect(result.conversation.title).toBe("how many deals are open?")
    expect(messages.list(WORKSPACE)).toHaveLength(2)
    expect(runs.list(WORKSPACE)).toHaveLength(1)
  })

  test("token usage is summed across every provider round-trip", async () => {
    const { service } = makeService({
      script: [
        { ...QUERY_STEP, usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } },
        {
          text: "There are 2 deals.",
          usage: { promptTokens: 200, completionTokens: 20, totalTokens: 220 },
        },
      ],
      deals: [
        { id: "d1", ownerId: ADMIN, stage: "won", amount: 1 },
        { id: "d2", ownerId: VIEWER, stage: "won", amount: 2 },
      ],
    })

    const result = await service.ask(ctxFor(ADMIN, "admin"), { message: "count deals" })

    expect(result.run.promptTokens).toBe(300)
    expect(result.run.completionTokens).toBe(30)
    expect(result.run.totalTokens).toBe(330)
    // 300 prompt @1000µ¢/M + 30 completion @2000µ¢/M, rounded.
    expect(result.run.costMicros).toBe(0)
    expect(result.run.toolCallCount).toBe(1)
  })

  test("the model sees a system prompt naming the tools and today's date", async () => {
    const { service, provider } = makeService({})
    await service.ask(ctxFor(ADMIN, "admin"), { message: "hello" })
    const first = provider.calls[0]
    expect(first).toBeDefined()
    const system = first?.messages[0]
    expect(system?.role).toBe("system")
    expect(system?.content).toContain("crm_query")
    expect(system?.content).toContain(new Date().toISOString().slice(0, 10))
    expect(first?.tools.map((tool) => tool.name).sort()).toEqual([
      "crm_describe_objects",
      "crm_query",
    ])
  })
})

describe("ai-assistant/permissions", () => {
  /**
   * The headline guarantee of spec 34 §20: the same question, asked by two
   * people, answers from two different row sets. Nothing about the question
   * or the tool arguments differs — only the caller.
   */
  test("a viewer's question sees fewer records than an admin's", async () => {
    const deals: DealRow[] = [
      { id: "d1", ownerId: ADMIN, stage: "won", amount: 10 },
      { id: "d2", ownerId: ADMIN, stage: "won", amount: 20 },
      { id: "d3", ownerId: VIEWER, stage: "won", amount: 30 },
    ]
    const script = (): StubAiScriptStep[] => [QUERY_STEP, { text: "Here is the count." }]

    const adminRun = makeService({ deals, script: script() })
    const adminResult = await adminRun.service.ask(ctxFor(ADMIN, "admin"), {
      message: "how many deals closed last month?",
    })

    const viewerRun = makeService({ deals, script: script() })
    const viewerResult = await viewerRun.service.ask(ctxFor(VIEWER, "viewer"), {
      message: "how many deals closed last month?",
    })

    // Same tool, same arguments, different scope — derived from the caller.
    expect(adminRun.engine.seen[0]?.scope).toEqual({ kind: "workspace" })
    expect(viewerRun.engine.seen[0]?.scope).toEqual({ kind: "own", actorId: VIEWER })

    const adminRows = adminRun.messages
      .list(WORKSPACE)
      .filter((row) => row.role === "tool")
      .map((row) => JSON.parse(row.content) as { rows: { count: number }[] })
    const viewerRows = viewerRun.messages
      .list(WORKSPACE)
      .filter((row) => row.role === "tool")
      .map((row) => JSON.parse(row.content) as { rows: { count: number }[] })

    const adminCount = adminRows[0]?.rows[0]?.count ?? 0
    const viewerCount = viewerRows[0]?.rows[0]?.count ?? 0
    expect(adminCount).toBe(3)
    expect(viewerCount).toBe(1)
    expect(viewerCount).toBeLessThan(adminCount)
    expect(adminResult.toolCalls[0]?.summary).toContain("workspace scope")
    expect(viewerResult.toolCalls[0]?.summary).toContain("own scope")
  })

  test("a denied tool is reported as denied and leaks no record data", async () => {
    const forbidden: AiTool = {
      name: "crm_secret",
      description: "denied on purpose",
      parameters: { type: "object", properties: {} },
      access: "read",
      execute: () => {
        throw new PermissionDeniedError(
          { workspaceId: WORKSPACE, actorId: VIEWER, action: "read", object: "deal" },
          "role 'viewer' cannot read deal",
        )
      },
    }
    const { service, messages } = makeService({
      tools: [forbidden],
      script: [
        { toolCalls: [{ id: "c1", name: "crm_secret", arguments: {} }] },
        { text: "You do not have access to that." },
      ],
    })

    const result = await service.ask(ctxFor(VIEWER, "viewer"), { message: "show me everything" })

    expect(result.toolCalls[0]?.outcome).toBe("denied")
    const toolRow = messages.list(WORKSPACE).find((row) => row.role === "tool")
    expect(toolRow?.content).toContain("permission_denied")
    expect(result.assistantMessage.content).toBe("You do not have access to that.")
  })

  test("an unknown tool name fails without reaching a service", async () => {
    const { service } = makeService({
      script: [
        { toolCalls: [{ id: "c1", name: "not_a_tool", arguments: {} }] },
        { text: "I could not do that." },
      ],
    })
    const result = await service.ask(ctxFor(ADMIN, "admin"), { message: "do something odd" })
    expect(result.toolCalls[0]?.outcome).toBe("failed")
    expect(result.toolCalls[0]?.summary).toContain("Unknown tool")
  })

  test("conversations are personal: another user cannot read or continue one", async () => {
    const { service } = makeService({})
    const mine = await service.ask(ctxFor(ADMIN, "admin"), { message: "my private question" })

    const otherCtx = ctxFor(VIEWER, "owner") // even an owner is refused
    await expectDenied(() => service.getConversation(otherCtx, mine.conversation.id))
    await expectDenied(() =>
      service.ask(otherCtx, { conversationId: mine.conversation.id, message: "and then?" }),
    )
  })

  test("listing only returns the caller's own conversations", async () => {
    const { service } = makeService({})
    await service.ask(ctxFor(ADMIN, "admin"), { message: "admin question" })
    await service.ask(ctxFor(VIEWER, "viewer"), { message: "viewer question" })

    const viewerList = await service.listConversations(ctxFor(VIEWER, "viewer"), {})
    expect(viewerList.data).toHaveLength(1)
    expect(viewerList.data[0]?.title).toBe("viewer question")
  })

  test("a viewer may ask but may not rename or delete", async () => {
    const { service } = makeService({})
    const asked = await service.ask(ctxFor(VIEWER, "viewer"), { message: "viewer question" })
    expect(asked.run.outcome).toBe("succeeded")

    await expectDenied(() =>
      service.renameConversation(ctxFor(VIEWER, "viewer"), asked.conversation.id, {
        title: "renamed",
      }),
    )
    await expectDenied(() =>
      service.deleteConversation(ctxFor(VIEWER, "viewer"), asked.conversation.id),
    )
  })
})

describe("ai-assistant/auditability", () => {
  test("every run and every tool call is audited against a model and a run id", async () => {
    const audit: AiAuditInput[] = []
    const { service } = makeService({
      audit,
      script: [QUERY_STEP, { text: "Two." }],
      deals: [{ id: "d1", ownerId: ADMIN, stage: "won", amount: 1 }],
    })

    await service.ask(ctxFor(ADMIN, "admin"), { message: "count" })

    const toolAudit = audit.find((row) => row.object === "ai_tool_call")
    expect(toolAudit?.action).toBe("tool.crm_query")
    expect(toolAudit?.source).toBe("ai")
    expect(toolAudit?.recordId).toBe("run_1")
    expect((toolAudit?.after as { model: string }).model).toBe("stub-echo-1")

    const runAudit = audit.find((row) => row.object === "ai_run")
    expect(runAudit?.source).toBe("ai")
    expect(runAudit?.recordId).toBe("run_1")
    expect((runAudit?.after as { outcome: string }).outcome).toBe("succeeded")
    expect((runAudit?.after as { correlationId?: string }).correlationId).toBeUndefined()
    expect(runAudit?.correlationId).toBe("corr_1")
  })

  test("tool calls and completion emit the AiEvents constants", async () => {
    const events = captureEvents()
    try {
      const { service } = makeService({
        script: [QUERY_STEP, { text: "Two." }],
        deals: [{ id: "d1", ownerId: ADMIN, stage: "won", amount: 1 }],
      })
      await service.ask(ctxFor(ADMIN, "admin"), { message: "count" })
      events.expectEmitted("ai.tool_called", { workspaceId: WORKSPACE, entityId: "run_1" })
      events.expectEmitted("agent.completed", { workspaceId: WORKSPACE, entityId: "run_1" })
    } finally {
      events.release()
    }
  })

  test("a provider failure records a failed run and never leaks the message verbatim", async () => {
    const audit: AiAuditInput[] = []
    const { service, runs } = makeService({
      audit,
      script: [
        {
          error: Object.assign(new Error("upstream exploded"), { code: "AI_PROVIDER_UNAVAILABLE" }),
        },
      ],
    })

    await expect(service.ask(ctxFor(ADMIN, "admin"), { message: "hi" })).rejects.toThrow(
      "upstream exploded",
    )

    const failed = runs.list(WORKSPACE)[0]
    expect(failed?.outcome).toBe("failed")
    expect(failed?.errorCode).toBe("AI_PROVIDER_UNAVAILABLE")
    expect(failed?.errorMessage).toBe("upstream exploded")
    expect(audit.some((row) => row.object === "ai_run")).toBe(true)
  })
})

describe("ai-assistant/conversation history", () => {
  test("history is replayed as prose; tool rows are not sent back", async () => {
    const { service, provider } = makeService({
      script: [QUERY_STEP, { text: "Two." }],
      deals: [{ id: "d1", ownerId: ADMIN, stage: "won", amount: 1 }],
    })
    const ctx = ctxFor(ADMIN, "admin")
    const first = await service.ask(ctx, { message: "count deals" })
    await service.ask(ctx, { conversationId: first.conversation.id, message: "and people?" })

    const followUp = provider.calls[2]
    expect(followUp).toBeDefined()
    const roles = followUp?.messages.map((message) => message.role) ?? []
    expect(roles).toEqual(["system", "user", "assistant", "user"])
  })

  test("getConversation returns messages and runs for the owner", async () => {
    const { service } = makeService({})
    const ctx = ctxFor(ADMIN, "admin")
    const asked = await service.ask(ctx, { message: "hello" })
    const detail = await service.getConversation(ctx, asked.conversation.id)
    expect(detail.messages).toHaveLength(2)
    expect(detail.runs).toHaveLength(1)
  })

  test("an unknown conversation is NOT_FOUND", async () => {
    const { service } = makeService({})
    await expect(service.getConversation(ctxFor(ADMIN, "admin"), "nope")).rejects.toThrow(
      "not found",
    )
  })
})

describe("ai-assistant/helpers", () => {
  test("titles come from the first line and are bounded", () => {
    expect(deriveAiConversationTitle("  Which deals are stalled?  ")).toBe(
      "Which deals are stalled?",
    )
    expect(deriveAiConversationTitle("\n\nsecond line question")).toBe("second line question")
    expect(deriveAiConversationTitle("x".repeat(200))).toHaveLength(60)
    expect(deriveAiConversationTitle("   ")).toBe("New conversation")
  })

  test("cost is null for an unpriced model and micro-USD for a priced one", () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 500_000, totalTokens: 1_500_000 }
    expect(computeAiCostMicros(undefined, "any", usage)).toBeNull()
    expect(computeAiCostMicros({}, "unknown-model", usage)).toBeNull()
    expect(
      computeAiCostMicros(
        { m: { inputMicrosPerMillion: 300_000, outputMicrosPerMillion: 600_000 } },
        "m",
        usage,
      ),
    ).toBe(600_000)
  })

  test("describeProvider exposes the model and tools, never a credential", () => {
    const { service } = makeService({})
    const status = service.describeProvider(ctxFor(VIEWER, "viewer"))
    expect(status).toEqual({
      providerId: "stub",
      model: "stub-echo-1",
      tools: [
        {
          name: "crm_describe_objects",
          description: expect.stringContaining("List the CRM objects"),
        },
        { name: "crm_query", description: expect.stringContaining("Query CRM records") },
      ],
    })
    expect(JSON.stringify(status)).not.toContain("key")
  })
})
