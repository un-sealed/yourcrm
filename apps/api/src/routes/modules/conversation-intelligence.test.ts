import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import { createStubAiProvider } from "@yourcrm/crm/src/ai-assistant"
import type { AiActionProposalPort } from "@yourcrm/crm/src/ai-governance"
import {
  createConversationIntelligenceService,
  createConversationSource,
  createConversationSourceRegistry,
  type CallTranscriptRecord,
  type ConversationAnalysisRecord,
  type ConversationIntelligenceService,
  type ConversationIntelligenceStore,
} from "@yourcrm/crm/src/conversation-intelligence"
import { createApiClient, createStore, makeBaseRecord, makeSession } from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes } from "./conversation-intelligence"

/**
 * Hermetic API test: the route factory takes a service, so this injects
 * the real domain service over an in-memory store, fake source adapters
 * and the deterministic stub provider — no network, no key, no Postgres.
 *
 * The properties themselves are proved in the domain tests. What is
 * proved here is that the HTTP layer does not weaken them: the same
 * caller who is refused in the service is refused over the wire, with the
 * right status and the shared error envelope.
 */

const WORKSPACE = "ws_api_ci"
const THREAD = "thread_1"

type Stored = BaseRecord & Record<string, unknown>

function makeFakeService(
  readers: Set<string>,
  proposals: unknown[],
): ConversationIntelligenceService {
  const analyses = createStore<Stored>()
  const transcripts = createStore<Stored>()

  const store: ConversationIntelligenceStore = {
    listAnalyses: async (workspaceId, query, subjectTypes) => {
      const limit = query.limit ?? 25
      const rows = analyses
        .list(workspaceId)
        .filter((row) => subjectTypes.includes(row.subjectType as never))
      return {
        data: rows.slice(0, limit) as unknown as ConversationAnalysisRecord[],
        pagination: { nextCursor: null, limit },
      }
    },
    findAnalysis: async (workspaceId, id) =>
      analyses.get(id, workspaceId) as unknown as ConversationAnalysisRecord | null,
    createAnalysis: async (workspaceId, input, actorId) =>
      analyses.insert({
        ...makeBaseRecord({ workspaceId }),
        ...input,
        requestedBy: actorId ?? null,
      }) as unknown as ConversationAnalysisRecord,
    updateAnalysis: async (workspaceId, id, patch) =>
      analyses.update(id, workspaceId, {
        ...patch,
      } as Partial<Stored>) as unknown as ConversationAnalysisRecord | null,
    listTranscripts: async (workspaceId, subjectType, subjectId) =>
      transcripts
        .list(workspaceId)
        .filter(
          (row) => row.subjectType === subjectType && row.subjectId === subjectId,
        ) as unknown as CallTranscriptRecord[],
    findTranscript: async (workspaceId, id) =>
      transcripts.get(id, workspaceId) as unknown as CallTranscriptRecord | null,
    findTranscriptByExternalId: async (workspaceId, externalId) =>
      (transcripts.list(workspaceId).find((row) => row.externalId === externalId) ??
        null) as unknown as CallTranscriptRecord | null,
    createTranscript: async (workspaceId, input) =>
      transcripts.insert({
        ...makeBaseRecord({ workspaceId }),
        ...input,
      }) as unknown as CallTranscriptRecord,
  }

  const governance: AiActionProposalPort = {
    requestAction: async (ctx, input) => {
      proposals.push(input)
      return {
        request: {
          id: "req_1",
          workspaceId: ctx.workspaceId,
          actorId: ctx.actorId,
          objectType: "task",
          action: "create",
          status: "pending",
        },
        mode: "require_approval",
        applied: false,
      }
    },
  }

  return createConversationIntelligenceService({
    store,
    sources: createConversationSourceRegistry([
      createConversationSource("email_thread", {
        read: async (ctx, subjectId) =>
          subjectId === THREAD && readers.has(ctx.actorId)
            ? {
                title: "Renewal for Northwind",
                turns: [
                  { speaker: "ada@northwind.test", at: null, text: "Can you resend the quote?" },
                  { speaker: "rep@acme.test", at: null, text: "Sent. I will call on Friday." },
                ],
                participants: ["ada@northwind.test", "rep@acme.test"],
                occurredAt: "2026-09-18T09:00:00.000Z",
              }
            : null,
        filterReadable: async (ctx, ids) =>
          readers.has(ctx.actorId) ? ids.filter((id) => id === THREAD) : [],
      }),
    ]),
    provider: createStubAiProvider({
      // One reply that satisfies every parser, so a test does not depend
      // on how many analyses ran before it.
      script: Array.from({ length: 8 }, () => ({
        text: '{"summary":"Ada asked for the quote.","items":[{"title":"Call Ada on Friday"}],"topics":["Renewal"],"label":"neutral"}',
      })),
    }),
    audit: async () => undefined,
    events: { emit: async () => undefined },
    governance,
    queue: { enqueueConversationAnalysis: async () => undefined },
  })
}

/** Sessions ride a tiny test-only middleware (role-accurate, no auth hook). */
function makeTestApp(
  session: { current: Session | null },
  service: ConversationIntelligenceService,
) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/conversation-intelligence", createRoutes({ service }))
  return app
}

describe("api/conversation-intelligence", () => {
  let session: { current: Session | null }
  let readers: Set<string>
  let proposals: unknown[]
  let api: ReturnType<typeof createApiClient>
  let owner: Session

  beforeEach(() => {
    owner = makeSession({ role: "owner", workspaceId: WORKSPACE })
    session = { current: owner }
    readers = new Set([owner.user.id])
    proposals = []
    api = createApiClient({ app: makeTestApp(session, makeFakeService(readers, proposals)) })
  })

  test("every route requires a session", async () => {
    session.current = null
    for (const path of [
      "/api/v1/conversation-intelligence/status",
      "/api/v1/conversation-intelligence/analyses",
      "/api/v1/conversation-intelligence/analyses/any",
    ]) {
      expect((await api.get(path)).status).toBe(401)
    }
    expect(
      (
        await api.post("/api/v1/conversation-intelligence/analyses", {
          subjectType: "email_thread",
          subjectId: THREAD,
          types: ["summary"],
        })
      ).status,
    ).toBe(401)
  })

  test("status describes the cap and the analysable channels", async () => {
    const res = await api.get("/api/v1/conversation-intelligence/status")
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      data: {
        providerId: "stub",
        maxSourceChars: 24_000,
        maxOutputTokens: 2_000,
        subjectTypes: ["email_thread"],
        queued: true,
      },
    })
  })

  test("analysing returns 201 with the attributed rows", async () => {
    const res = await api.post("/api/v1/conversation-intelligence/analyses", {
      subjectType: "email_thread",
      subjectId: THREAD,
      types: ["summary"],
    })
    expect(res.status).toBe(201)
    const rows = (res.body as { data: Record<string, unknown>[] }).data
    expect(rows[0]).toMatchObject({
      analysisType: "summary",
      status: "succeeded",
      providerId: "stub",
      model: "stub-echo-1",
      truncated: false,
    })
    expect(rows[0]?.runId).toBeTruthy()
  })

  test("queuing returns 202 and does not call the provider", async () => {
    const res = await api.post("/api/v1/conversation-intelligence/analyses/queue", {
      subjectType: "email_thread",
      subjectId: THREAD,
      types: ["summary"],
    })
    expect(res.status).toBe(202)
    expect((res.body as { data: { status: string }[] }).data[0]?.status).toBe("queued")
  })

  test("a bad body is a 400 with the shared error envelope", async () => {
    const res = await api.post("/api/v1/conversation-intelligence/analyses", {
      subjectType: "carrier_pigeon",
      subjectId: THREAD,
      types: [],
    })
    expect(res.status).toBe(400)
    expect((res.body as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR")
  })

  test("a conversation the caller cannot read is a 404, not a 403", async () => {
    // Indistinguishable from "no such thread" — an analysis request must
    // never be a probe for the existence of somebody else's conversation.
    readers.clear()
    const res = await api.post("/api/v1/conversation-intelligence/analyses", {
      subjectType: "email_thread",
      subjectId: THREAD,
      types: ["summary"],
    })
    expect(res.status).toBe(404)
    expect((res.body as { error: { code: string } }).error.code).toBe("NOT_FOUND")
  })

  test("the detail route returns the analysis with its source conversation", async () => {
    const created = await api.post("/api/v1/conversation-intelligence/analyses", {
      subjectType: "email_thread",
      subjectId: THREAD,
      types: ["summary"],
    })
    const id = String((created.body as { data: { id: string }[] }).data[0]?.id)
    const res = await api.get(`/api/v1/conversation-intelligence/analyses/${id}`)
    expect(res.status).toBe(200)
    const body = res.body as { data: { subject: { title: string; turns: unknown[] } } }
    expect(body.data.subject.title).toBe("Renewal for Northwind")
    expect(body.data.subject.turns.length).toBe(2)
  })

  test("the list is filtered by the visibility of each conversation", async () => {
    await api.post("/api/v1/conversation-intelligence/analyses", {
      subjectType: "email_thread",
      subjectId: THREAD,
      types: ["summary"],
    })
    expect(
      (
        (await api.get("/api/v1/conversation-intelligence/analyses")).body as {
          data: unknown[]
        }
      ).data.length,
    ).toBe(1)

    // Same workspace, same role — but Email does not show them the thread.
    session.current = makeSession({ role: "owner", workspaceId: WORKSPACE })
    const res = await api.get("/api/v1/conversation-intelligence/analyses")
    expect(res.status).toBe(200)
    expect((res.body as { data: unknown[] }).data).toEqual([])
  })

  test("proposing an action item returns a pending request, never a task", async () => {
    const created = await api.post("/api/v1/conversation-intelligence/analyses", {
      subjectType: "email_thread",
      subjectId: THREAD,
      types: ["action_items"],
    })
    const id = String((created.body as { data: { id: string }[] }).data[0]?.id)

    const items = await api.get(`/api/v1/conversation-intelligence/analyses/${id}/action-items`)
    expect((items.body as { data: { title: string }[] }).data[0]?.title).toBe("Call Ada on Friday")

    const res = await api.post(
      `/api/v1/conversation-intelligence/analyses/${id}/action-items/propose`,
      { itemIndex: 0 },
    )
    expect(res.status).toBe(201)
    expect((res.body as { data: { request: { status: string } } }).data.request.status).toBe(
      "pending",
    )
    expect(proposals.length).toBe(1)
    expect(proposals[0]).toMatchObject({ objectType: "task", action: "create" })
  })

  test("a transcript ingest is idempotent over the wire", async () => {
    const payload = {
      subjectType: "email_thread",
      subjectId: THREAD,
      source: "provider",
      providerId: "acme-notetaker",
      externalId: "acme_7",
      segments: [{ speaker: "Ada", text: "Hello there" }],
    }
    const first = await api.post("/api/v1/conversation-intelligence/transcripts", payload)
    const second = await api.post("/api/v1/conversation-intelligence/transcripts", payload)
    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect((second.body as { data: { id: string } }).data.id).toBe(
      (first.body as { data: { id: string } }).data.id,
    )
  })

  test("transcripts and subject analyses inherit the conversation's visibility", async () => {
    await api.post("/api/v1/conversation-intelligence/transcripts", {
      subjectType: "email_thread",
      subjectId: THREAD,
      source: "manual",
      text: "a pasted transcript",
    })
    expect(
      (
        await api.get(
          `/api/v1/conversation-intelligence/subjects/email_thread/${THREAD}/transcripts`,
        )
      ).status,
    ).toBe(200)

    readers.clear()
    expect(
      (
        await api.get(
          `/api/v1/conversation-intelligence/subjects/email_thread/${THREAD}/transcripts`,
        )
      ).status,
    ).toBe(404)
    expect(
      (await api.get(`/api/v1/conversation-intelligence/subjects/email_thread/${THREAD}/analyses`))
        .status,
    ).toBe(404)
  })

  test("an unknown subject type in the path is a 400", async () => {
    const res = await api.get("/api/v1/conversation-intelligence/subjects/telepathy/abc/analyses")
    expect(res.status).toBe(400)
  })
})
