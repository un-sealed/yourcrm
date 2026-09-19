import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import {
  createAiAssistantService,
  createAiCrmTools,
  createStubAiProvider,
  type AiAssistantService,
  type AiAssistantStore,
  type AiConversationRecord,
  type AiMessageInsert,
  type AiMessageRecord,
  type AiRunInsert,
  type AiRunRecord,
  type StubAiScriptStep,
} from "@yourcrm/crm/src/ai-assistant"
import {
  describeReportObjects,
  planReportExecution,
  type ReportExecutionRequest,
  type ReportRowScope,
} from "@yourcrm/database/src/repositories/reports-repository"
import { createApiClient, createStore, makeBaseRecord, makeSession } from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes } from "./ai"

/**
 * Hermetic API test: the route factory takes a service, so tests inject
 * the real domain service over an in-memory store and the deterministic
 * stub provider — no network, no key, no Postgres.
 *
 * The query tool still runs the REAL report planner from
 * `@yourcrm/database`, so the allowlist and the row-scope contract are
 * exercised exactly as in production.
 */

type StoredConversation = BaseRecord & { title: string; userId: string; model: string | null }
type StoredMessage = BaseRecord & AiMessageInsert & { sequence: number }
type StoredRun = BaseRecord & AiRunInsert

type DealRow = { workspaceId: string; ownerId: string; stage: string }

function makeFakeService(deals: DealRow[], script: StubAiScriptStep[]): AiAssistantService {
  const conversations = createStore<StoredConversation>()
  const messages = createStore<StoredMessage>()
  const runs = createStore<StoredRun>()
  let sequence = 0

  const store: AiAssistantStore = {
    listConversations: async (workspaceId, query, scope) => {
      const rows = conversations.list(workspaceId).filter((row) => row.userId === scope.actorId)
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
    listMessages: async (workspaceId, conversationId) =>
      messages
        .list(workspaceId)
        .filter((row) => row.conversationId === conversationId)
        .sort((a, b) => a.sequence - b.sequence) as unknown as AiMessageRecord[],
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

  return createAiAssistantService({
    store,
    provider: createStubAiProvider({ script }),
    tools: createAiCrmTools({
      reports: {
        describeObjects: () => describeReportObjects(),
        execute: async (workspaceId, request: ReportExecutionRequest, scope: ReportRowScope) => {
          // Real planner: proves the definition compiles to safe SQL and
          // that the caller's scope reached the engine, without Postgres.
          const plan = planReportExecution(
            workspaceId,
            request as Parameters<typeof planReportExecution>[1],
            scope,
          )
          const visible = deals.filter(
            (deal) =>
              deal.workspaceId === workspaceId &&
              (scope.kind === "workspace" || deal.ownerId === scope.actorId),
          )
          return {
            objectType: request.objectType,
            mode: plan.mode,
            scope: plan.scope,
            columns: plan.columns,
            rows: [{ count: visible.length }],
            rowCount: visible.length,
            limit: plan.limit,
            truncated: false,
          }
        },
      },
    }),
    audit: async () => undefined,
  })
}

/** Sessions ride a tiny test-only middleware (role-accurate, no auth hook). */
function makeTestApp(session: { current: Session | null }, service: AiAssistantService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/ai", createRoutes({ service }))
  return app
}

const QUERY_SCRIPT = (): StubAiScriptStep[] => [
  {
    toolCalls: [
      {
        id: "call_1",
        name: "crm_query",
        arguments: { objectType: "deal", aggregations: [{ fn: "count" }] },
      },
    ],
  },
  { text: "Counted the deals you can see." },
]

const WORKSPACE = "ws_api_ai"

describe("api/ai", () => {
  let session: { current: Session | null }
  let owner: Session

  beforeEach(() => {
    owner = makeSession({ role: "owner", workspaceId: WORKSPACE })
    session = { current: owner }
  })

  test("unauthenticated requests get UNAUTHORIZED", async () => {
    session.current = null
    const api = createApiClient({ app: makeTestApp(session, makeFakeService([], [])) })
    const res = await api.post("/api/v1/ai/chat", { message: "hi" })
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("chat answers with the model that produced the text and a run", async () => {
    const api = createApiClient({ app: makeTestApp(session, makeFakeService([], [])) })
    const res = await api.post("/api/v1/ai/chat", { message: "hello there" })
    expect(res.status).toBe(200)
    const data = res.expectSuccess().data as {
      assistantMessage: { content: string; model: string }
      run: { outcome: string; totalTokens: number; providerId: string }
      toolCalls: unknown[]
    }
    expect(data.assistantMessage.content).toBe("stub: hello there")
    expect(data.assistantMessage.model).toBe("stub-echo-1")
    expect(data.run.outcome).toBe("succeeded")
    expect(data.run.providerId).toBe("stub")
    expect(data.toolCalls).toEqual([])
  })

  test("an empty message is a 400 with the validation envelope", async () => {
    const api = createApiClient({ app: makeTestApp(session, makeFakeService([], [])) })
    const res = await api.post("/api/v1/ai/chat", { message: "   " })
    expect(res.status).toBe(400)
    res.expectError("VALIDATION_ERROR")
  })

  /**
   * Spec 34 §20, over HTTP: the same question, two callers, two answers.
   * Only the session differs — not the question, not the tool arguments.
   */
  test("a viewer's answer covers fewer records than an admin's", async () => {
    const deals: DealRow[] = [
      { workspaceId: WORKSPACE, ownerId: "user_admin", stage: "won" },
      { workspaceId: WORKSPACE, ownerId: "user_admin", stage: "won" },
      { workspaceId: WORKSPACE, ownerId: "user_viewer", stage: "won" },
    ]
    const question = { message: "how many deals closed last month?" }

    const adminSession = makeSession({
      role: "admin",
      workspaceId: WORKSPACE,
      userId: "user_admin",
    })
    const adminApi = createApiClient({
      app: makeTestApp({ current: adminSession }, makeFakeService(deals, QUERY_SCRIPT())),
    })
    const adminRes = await adminApi.post("/api/v1/ai/chat", question)
    expect(adminRes.status).toBe(200)
    const adminSummary = (adminRes.expectSuccess().data as { toolCalls: { summary: string }[] })
      .toolCalls[0]?.summary

    const viewerSession = makeSession({
      role: "viewer",
      workspaceId: WORKSPACE,
      userId: "user_viewer",
    })
    const viewerApi = createApiClient({
      app: makeTestApp({ current: viewerSession }, makeFakeService(deals, QUERY_SCRIPT())),
    })
    const viewerRes = await viewerApi.post("/api/v1/ai/chat", question)
    expect(viewerRes.status).toBe(200)
    const viewerSummary = (viewerRes.expectSuccess().data as { toolCalls: { summary: string }[] })
      .toolCalls[0]?.summary

    expect(adminSummary).toBe("deal: 3 group(s) (workspace scope)")
    expect(viewerSummary).toBe("deal: 1 group(s) (own scope)")
  })

  test("conversations are personal: another user gets 403, unknown ids 404", async () => {
    const service = makeFakeService([], [])
    const mineApi = createApiClient({ app: makeTestApp(session, service) })
    const created = await mineApi.post("/api/v1/ai/chat", { message: "my question" })
    const conversationId = (created.expectSuccess().data as { conversation: { id: string } })
      .conversation.id

    const other = makeSession({ role: "owner", workspaceId: WORKSPACE, userId: "someone_else" })
    const otherApi = createApiClient({ app: makeTestApp({ current: other }, service) })
    const forbidden = await otherApi.get(`/api/v1/ai/conversations/${conversationId}`)
    expect(forbidden.status).toBe(403)
    forbidden.expectError("FORBIDDEN")

    const missing = await mineApi.get("/api/v1/ai/conversations/does-not-exist")
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")
  })

  test("the conversation list is scoped to the caller and paginated", async () => {
    const service = makeFakeService([], [])
    const api = createApiClient({ app: makeTestApp(session, service) })
    await api.post("/api/v1/ai/chat", { message: "first question" })

    const other = makeSession({ role: "owner", workspaceId: WORKSPACE, userId: "someone_else" })
    const otherApi = createApiClient({ app: makeTestApp({ current: other }, service) })
    await otherApi.post("/api/v1/ai/chat", { message: "their question" })

    const res = await api.get("/api/v1/ai/conversations")
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("a viewer may chat but may not rename or delete a conversation", async () => {
    const viewer = makeSession({ role: "viewer", workspaceId: WORKSPACE, userId: "user_viewer" })
    const service = makeFakeService([], [])
    const api = createApiClient({ app: makeTestApp({ current: viewer }, service) })
    const created = await api.post("/api/v1/ai/chat", { message: "viewer question" })
    expect(created.status).toBe(200)
    const id = (created.expectSuccess().data as { conversation: { id: string } }).conversation.id

    const renamed = await api.patch(`/api/v1/ai/conversations/${id}`, { title: "new title" })
    expect(renamed.status).toBe(403)
    const deleted = await api.delete(`/api/v1/ai/conversations/${id}`)
    expect(deleted.status).toBe(403)
  })

  test("the transcript endpoint returns messages and runs", async () => {
    const service = makeFakeService([], QUERY_SCRIPT())
    const api = createApiClient({ app: makeTestApp(session, service) })
    const created = await api.post("/api/v1/ai/chat", { message: "count deals" })
    const id = (created.expectSuccess().data as { conversation: { id: string } }).conversation.id

    const res = await api.get(`/api/v1/ai/conversations/${id}`)
    expect(res.status).toBe(200)
    const detail = res.expectSuccess().data as {
      messages: { role: string }[]
      runs: { outcome: string }[]
    }
    expect(detail.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ])
    expect(detail.runs).toHaveLength(1)
  })

  test("the provider endpoint describes the model and tools without secrets", async () => {
    const api = createApiClient({ app: makeTestApp(session, makeFakeService([], [])) })
    const res = await api.get("/api/v1/ai/provider")
    expect(res.status).toBe(200)
    const data = res.expectSuccess().data as { providerId: string; model: string; tools: unknown[] }
    expect(data.providerId).toBe("stub")
    expect(data.model).toBe("stub-echo-1")
    expect(data.tools).toHaveLength(2)
    expect(JSON.stringify(data)).not.toContain("Bearer")
  })

  test("a provider outage maps to 502 with the typed code", async () => {
    const failing = makeFakeService(
      [],
      [{ error: Object.assign(new Error("gateway down"), { code: "AI_PROVIDER_UNAVAILABLE" }) }],
    )
    const api = createApiClient({ app: makeTestApp(session, failing) })
    const res = await api.post("/api/v1/ai/chat", { message: "hi" })
    expect(res.status).toBe(502)
    res.expectError("AI_PROVIDER_UNAVAILABLE")
  })

  test("a provider timeout maps to 504", async () => {
    const failing = makeFakeService(
      [],
      [{ error: Object.assign(new Error("too slow"), { code: "AI_PROVIDER_TIMEOUT" }) }],
    )
    const api = createApiClient({ app: makeTestApp(session, failing) })
    const res = await api.post("/api/v1/ai/chat", { message: "hi" })
    expect(res.status).toBe(504)
    res.expectError("AI_PROVIDER_TIMEOUT")
  })

  test("route construction performs no side effects", () => {
    expect(() => createRoutes()).not.toThrow()
  })
})
