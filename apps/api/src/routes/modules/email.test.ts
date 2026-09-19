import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import {
  createConsoleEmailProvider,
  createEmailService,
  createEmailTransportCatalog,
  type EmailMessageDetail,
  type EmailMessageRecord,
  type EmailMessageStore,
  type EmailParticipantRecord,
  type EmailService,
  type EmailThreadListQuery,
  type EmailThreadRecord,
  type EmailThreadStore,
} from "@yourcrm/crm/src/email"
import { getIntegrationProviderRegistry } from "@yourcrm/integrations"
import { createApiClient, createStore, makeBaseRecord, makeSession } from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes } from "./email"

const CONNECTION_ID = "conn_email_api"
const SECRET = "dev-token-for-api-tests"

type StoredThread = BaseRecord & {
  subject: string | null
  normalizedSubject: string
  participantKey: string
  status: string
  messageCount: number
  lastMessageAt: Date | null
  ownerId: string | null
  personId: string | null
  companyId: string | null
  dealId: string | null
}

type StoredMessage = BaseRecord & {
  threadId: string
  direction: string
  status: string
  messageId: string | null
  inReplyTo: string | null
  referenceIds: string[]
  subject: string | null
  fromAddress: string | null
  bodyText: string | null
  bodyHtml: string | null
  snippet: string | null
  connectionId: string | null
  providerId: string | null
  providerMessageId: string | null
  sentAt: Date | null
  receivedAt: Date | null
  lastError: string | null
}

function str(input: Record<string, unknown>, key: string): string | null {
  const value = input[key]
  return typeof value === "string" ? value : null
}

function strArray(input: Record<string, unknown>, key: string): string[] {
  const value = input[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function dateOf(input: Record<string, unknown>, key: string): Date | null {
  const value = input[key]
  return value instanceof Date ? value : null
}

/** Real domain service over hermetic in-memory stores + the console provider. */
function makeFakeService() {
  const threads = createStore<StoredThread>()
  const messages = createStore<StoredMessage>()
  const participants: (EmailParticipantRecord & { emailMessageId: string })[] = []
  const provider = createConsoleEmailProvider({ log: false })

  const asThread = (row: StoredThread): EmailThreadRecord => row as unknown as EmailThreadRecord
  const asMessage = (row: StoredMessage): EmailMessageRecord => row as unknown as EmailMessageRecord
  const detailOf = (row: StoredMessage): EmailMessageDetail => ({
    message: asMessage(row),
    participants: participants.filter((p) => p.emailMessageId === row.id),
    attachments: [],
  })

  const threadStore: EmailThreadStore = {
    list: async (workspaceId: string, query: EmailThreadListQuery) => {
      const rows = threads.list(workspaceId)
      const limit = query.limit ?? 25
      const data = rows.slice(0, limit)
      return {
        data: data.map(asThread),
        pagination: {
          nextCursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null,
          limit,
        },
      }
    },
    findById: async (workspaceId, id) => {
      const row = threads.get(id, workspaceId)
      return row ? asThread(row) : null
    },
    findWithMessages: async (workspaceId, id) => {
      const thread = threads.get(id, workspaceId)
      if (!thread) return null
      return {
        thread: asThread(thread),
        messages: messages
          .list(workspaceId)
          .filter((row) => row.threadId === id)
          .map(detailOf),
      }
    },
    create: async (workspaceId, input, actorId) =>
      asThread(
        threads.insert({
          ...makeBaseRecord({ workspaceId }),
          subject: str(input, "subject"),
          normalizedSubject: str(input, "normalizedSubject") ?? "",
          participantKey: str(input, "participantKey") ?? "",
          status: str(input, "status") ?? "open",
          messageCount: 0,
          lastMessageAt: dateOf(input, "lastMessageAt"),
          ownerId: str(input, "ownerId"),
          personId: str(input, "personId"),
          companyId: str(input, "companyId"),
          dealId: str(input, "dealId"),
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      ),
    update: async (workspaceId, id, patch) => {
      const row = threads.update(id, workspaceId, patch as Partial<StoredThread>)
      return row ? asThread(row) : null
    },
    refreshCounters: async (workspaceId, threadId, lastMessageAt) => {
      const count = messages.list(workspaceId).filter((row) => row.threadId === threadId).length
      const row = threads.update(threadId, workspaceId, { messageCount: count, lastMessageAt })
      return row ? asThread(row) : null
    },
    softDelete: async (workspaceId, id) => {
      threads.remove(id, workspaceId)
    },
    findThreadIdsByMessageIds: async (workspaceId, ids) =>
      messages
        .list(workspaceId)
        .filter((row) => row.messageId !== null && ids.includes(row.messageId))
        .map((row) => ({ messageId: row.messageId as string, threadId: row.threadId })),
    findThreadByMatch: async (workspaceId, match) => {
      if (match.normalizedSubject.length === 0 || match.participantKey.length === 0) return null
      const found = threads
        .list(workspaceId)
        .find(
          (row) =>
            row.normalizedSubject === match.normalizedSubject &&
            row.participantKey === match.participantKey,
        )
      return found ? { id: found.id } : null
    },
  }

  const messageStore: EmailMessageStore = {
    create: async (workspaceId, input, actorId) => {
      const stored = messages.insert({
        ...makeBaseRecord({ workspaceId }),
        threadId: str(input, "threadId") ?? "",
        direction: str(input, "direction") ?? "outbound",
        status: str(input, "status") ?? "queued",
        messageId: str(input, "messageId"),
        inReplyTo: str(input, "inReplyTo"),
        referenceIds: strArray(input, "referenceIds"),
        subject: str(input, "subject"),
        fromAddress: str(input, "fromAddress"),
        bodyText: str(input, "bodyText"),
        bodyHtml: str(input, "bodyHtml"),
        snippet: str(input, "snippet"),
        connectionId: str(input, "connectionId"),
        providerId: str(input, "providerId"),
        providerMessageId: str(input, "providerMessageId"),
        sentAt: dateOf(input, "sentAt"),
        receivedAt: dateOf(input, "receivedAt"),
        lastError: str(input, "lastError"),
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      })
      const raw = input.participants
      if (Array.isArray(raw)) {
        for (const item of raw) {
          const record = item as Record<string, unknown>
          participants.push({
            id: `part_${participants.length + 1}`,
            emailMessageId: stored.id,
            role: str(record, "role") ?? "to",
            address: str(record, "address") ?? "",
          })
        }
      }
      return detailOf(stored)
    },
    update: async (workspaceId, id, patch) => {
      const row = messages.update(id, workspaceId, patch as Partial<StoredMessage>)
      return row ? asMessage(row) : null
    },
    findById: async (workspaceId, id) => {
      const row = messages.get(id, workspaceId)
      return row ? asMessage(row) : null
    },
    findByMessageId: async (workspaceId, messageId) => {
      const row = messages.list(workspaceId).find((item) => item.messageId === messageId)
      return row ? asMessage(row) : null
    },
    findWithDetail: async (workspaceId, id) => {
      const row = messages.get(id, workspaceId)
      return row ? detailOf(row) : null
    },
  }

  const service = createEmailService({
    threads: threadStore,
    messages: messageStore,
    connections: {
      findSendable: async () => ({
        id: CONNECTION_ID,
        providerId: provider.id,
        config: { fromAddress: "sales@yourcrm.test" },
      }),
    },
    secrets: { readApiKey: async () => SECRET },
    transports: createEmailTransportCatalog([provider]),
    audit: async () => undefined,
  })
  return { service, provider, threads, messages }
}

/**
 * Hermetic API test: the route factory takes a service, so tests inject the
 * real domain service over in-memory stores. Sessions ride a tiny test-only
 * middleware (role-accurate without touching the foundation auth hook).
 */
function makeTestApp(session: { current: Session | null }, service: EmailService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/email", createRoutes({ service }))
  return app
}

const sendBody = {
  subject: "Q3 Budget",
  to: [{ address: "ada@example.com" }],
  bodyText: "Numbers attached.",
}

describe("api/email", () => {
  let session: { current: Session | null }
  let fixture: ReturnType<typeof makeFakeService>

  beforeEach(() => {
    session = { current: makeSession({ role: "owner" }) }
    fixture = makeFakeService()
  })

  test("unauthenticated requests get UNAUTHORIZED", async () => {
    session.current = null
    const api = createApiClient({ app: makeTestApp(session, fixture.service) })
    const res = await api.get("/api/v1/email/threads")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("thread list returns the cursor pagination envelope", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture.service) })
    const empty = await api.get("/api/v1/email/threads")
    expect(empty.status).toBe(200)
    expect(empty.expectSuccess().pagination).toEqual({ nextCursor: null, limit: 25 })

    await api.post("/api/v1/email/messages", sendBody)
    const filled = await api.get("/api/v1/email/threads")
    expect(filled.expectSuccess().data).toHaveLength(1)
  })

  test("invalid query parameters are a 400 VALIDATION_ERROR", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture.service) })
    const res = await api.get("/api/v1/email/threads?limit=9999")
    expect(res.status).toBe(400)
    res.expectError("VALIDATION_ERROR")
  })

  test("POST /messages sends and returns 201 with the provider message id", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture.service) })
    const res = await api.post("/api/v1/email/messages", sendBody)
    expect(res.status).toBe(201)
    const body = res.expectSuccess().data as { message: Record<string, unknown> }
    expect(body.message.direction).toBe("outbound")
    expect(body.message.status).toBe("sent")
    expect(String(body.message.providerMessageId)).toMatch(/^console-/)
    expect(fixture.provider.outbox).toHaveLength(1)
  })

  test("a VIEWER is denied sending (send_external) with 403", async () => {
    session.current = makeSession({ role: "viewer" })
    const api = createApiClient({ app: makeTestApp(session, fixture.service) })
    const res = await api.post("/api/v1/email/messages", sendBody)
    expect(res.status).toBe(403)
    res.expectError("FORBIDDEN")
    expect(fixture.provider.outbox).toHaveLength(0)
  })

  test("a viewer may still read threads", async () => {
    session.current = makeSession({ role: "viewer" })
    const api = createApiClient({ app: makeTestApp(session, fixture.service) })
    const res = await api.get("/api/v1/email/threads")
    expect(res.status).toBe(200)
  })

  test("an invalid send body is a 400 VALIDATION_ERROR", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture.service) })
    const res = await api.post("/api/v1/email/messages", { subject: "hi", to: [] })
    expect(res.status).toBe(400)
    res.expectError("VALIDATION_ERROR")
  })

  test("no response ever carries the provider secret", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture.service) })
    const sent = await api.post("/api/v1/email/messages", sendBody)
    const detail = await api.get("/api/v1/email/threads")
    expect(JSON.stringify(sent.body)).not.toContain(SECRET)
    expect(JSON.stringify(detail.body)).not.toContain(SECRET)
  })

  test("the message payload never exposes the raw provider html", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture.service) })
    const sent = await api.post("/api/v1/email/messages", {
      ...sendBody,
      bodyText: "",
      bodyHtml: "<p>hi</p><script>steal()</script>",
    })
    const body = sent.expectSuccess().data as { message: Record<string, unknown> }
    const messageId = String(body.message.id)
    const fetched = await api.get(`/api/v1/email/messages/${messageId}`)
    // The stored html is sanitised, and the DTO omits it entirely.
    expect(JSON.stringify(fetched.body)).not.toContain("script")
    expect(fetched.expectSuccess().data).toBeDefined()
  })

  test("GET /threads/:id returns the thread with its messages; unknown id is 404", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture.service) })
    const sent = await api.post("/api/v1/email/messages", sendBody)
    const body = sent.expectSuccess().data as { message: Record<string, unknown> }
    const threadId = String(body.message.threadId)

    const ok = await api.get(`/api/v1/email/threads/${threadId}`)
    expect(ok.status).toBe(200)
    const detail = ok.expectSuccess().data as { messages: unknown[] }
    expect(detail.messages).toHaveLength(1)

    const missing = await api.get("/api/v1/email/threads/nope")
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")
  })

  test("PATCH /threads/:id links the thread to a CRM record", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture.service) })
    const sent = await api.post("/api/v1/email/messages", sendBody)
    const body = sent.expectSuccess().data as { message: Record<string, unknown> }
    const threadId = String(body.message.threadId)

    const res = await api.patch(`/api/v1/email/threads/${threadId}`, { personId: "person_1" })
    expect(res.status).toBe(200)
    expect((res.expectSuccess().data as Record<string, unknown>).personId).toBe("person_1")
  })

  test("a viewer is denied linking a thread", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture.service) })
    const sent = await api.post("/api/v1/email/messages", sendBody)
    const body = sent.expectSuccess().data as { message: Record<string, unknown> }
    const threadId = String(body.message.threadId)

    session.current = makeSession({ role: "viewer" })
    const res = await api.patch(`/api/v1/email/threads/${threadId}`, { personId: "person_1" })
    expect(res.status).toBe(403)
  })

  test("DELETE /threads/:id soft-deletes; a viewer is denied", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture.service) })
    const owner = session.current
    const sent = await api.post("/api/v1/email/messages", sendBody)
    const body = sent.expectSuccess().data as { message: Record<string, unknown> }
    const threadId = String(body.message.threadId)

    session.current = makeSession({ role: "viewer" })
    expect((await api.delete(`/api/v1/email/threads/${threadId}`)).status).toBe(403)

    // Same workspace, owner role: the delete lands and the thread is gone.
    session.current = owner
    expect((await api.delete(`/api/v1/email/threads/${threadId}`)).status).toBe(200)
    expect((await api.get(`/api/v1/email/threads/${threadId}`)).status).toBe(404)
  })

  test("importing this module registers the email adapter in the connector registry", () => {
    // Inbound email reaches the framework's single webhook endpoint, which
    // resolves the provider out of this registry.
    const registry = getIntegrationProviderRegistry()
    const provider = registry.get("console-email")
    expect(provider).not.toBeNull()
    expect(provider?.category).toBe("email")
    expect(registry.byCapability("email.send").map((p) => p.id)).toContain("console-email")
    expect(registry.byCapability("email.receive").map((p) => p.id)).toContain("console-email")
    expect(provider?.webhook?.signatureHeader).toBe("x-yourcrm-signature")
    // API-key only in P0 — no OAuth anywhere.
    expect(provider?.authKind).toBe("api_key")
  })

  test("there is no second webhook route in this module", async () => {
    // Inbound email belongs to the connector framework's single public
    // endpoint (/api/v1/integrations/:connectionId/webhook).
    const api = createApiClient({ app: makeTestApp(session, fixture.service) })
    const res = await api.post("/api/v1/email/webhook", { hello: "world" })
    expect(res.status).toBe(404)
  })
})
