import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import {
  createWhatsAppService,
  type WhatsAppConnectionPort,
  type WhatsAppConnectionRecord,
  type WhatsAppConversationRecord,
  type WhatsAppMessageRecord,
  type WhatsAppProviderAdapter,
  type WhatsAppService,
  type WhatsAppTemplateRecord,
} from "@yourcrm/crm/src/whatsapp"
import { createApiClient, createStore, makeBaseRecord, makeSession, nextId } from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes } from "./whatsapp"

const CONNECTION_ID = "conn-1"
const API_KEY = "dev-secret-0123456789"

type StoredConversation = BaseRecord & Record<string, unknown>
type StoredMessage = BaseRecord & Record<string, unknown>
type StoredTemplate = BaseRecord & Record<string, unknown>

const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, failed: 2, delivered: 3, read: 4 }

/**
 * Hermetic API test: the real domain service over in-memory stores, same
 * pattern `integrations.test.ts` uses. `ingestInboundMessage` is called
 * directly (not through HTTP — it has no route by design, see the module
 * header) to open the 24h session window before exercising `POST
 * .../messages`.
 */
function makeFakeService(workspaceId: string): WhatsAppService {
  const conversations = createStore<StoredConversation>()
  const messages = createStore<StoredMessage>()
  const templates = createStore<StoredTemplate>()
  const connectionsById = new Map<string, WhatsAppConnectionRecord>()
  const secrets = new Map<string, string>()

  const connections: WhatsAppConnectionPort = {
    findById: async (workspaceId, id) => {
      const row = connectionsById.get(id)
      return row && row.workspaceId === workspaceId ? row : null
    },
    readSecret: async (_workspaceId, id) => secrets.get(id) ?? null,
  }

  const provider: WhatsAppProviderAdapter = {
    sendText: async () => ({ providerMessageId: nextId("prov") }),
    sendTemplate: async () => ({ providerMessageId: nextId("prov") }),
  }

  connectionsById.set(CONNECTION_ID, {
    id: CONNECTION_ID,
    workspaceId,
    providerId: "whatsapp-console",
    status: "connected",
    config: {},
  })
  secrets.set(CONNECTION_ID, API_KEY)

  return createWhatsAppService({
    conversations: {
      list: async (workspaceId, query) => {
        let rows = conversations.list(workspaceId)
        if (query.status) rows = rows.filter((r) => r.status === query.status)
        const limit = query.limit ?? 25
        return {
          data: rows.slice(0, limit) as unknown as WhatsAppConversationRecord[],
          pagination: { nextCursor: null, limit },
        }
      },
      findById: async (workspaceId, id) => {
        const row = conversations.get(id, workspaceId)
        return (row as unknown as WhatsAppConversationRecord) ?? null
      },
      findOrCreate: async (workspaceId, input, actorId) => {
        const rec = input as {
          connectionId: string
          contactPhone: string
          personId?: string | null
          companyId?: string | null
        }
        const existing = conversations
          .list(workspaceId)
          .find((r) => r.connectionId === rec.connectionId && r.contactPhone === rec.contactPhone)
        if (existing)
          return { record: existing as unknown as WhatsAppConversationRecord, created: false }
        const row = conversations.insert({
          ...makeBaseRecord({
            workspaceId,
            ...(actorId ? { createdBy: actorId, updatedBy: actorId } : {}),
          }),
          connectionId: rec.connectionId,
          contactPhone: rec.contactPhone,
          personId: rec.personId ?? null,
          companyId: rec.companyId ?? null,
          status: "open",
          lastInboundAt: null,
          lastOutboundAt: null,
          lastMessageAt: null,
          lastMessagePreview: null,
          unreadCount: 0,
        })
        return { record: row as unknown as WhatsAppConversationRecord, created: true }
      },
      update: async (workspaceId, id, patch) => {
        const row = conversations.update(id, workspaceId, patch as Partial<StoredConversation>)
        return (row as unknown as WhatsAppConversationRecord) ?? null
      },
      touchInbound: async (workspaceId, conversationId, occurredAt, previewText) => {
        const current = conversations.get(conversationId, workspaceId)
        conversations.update(conversationId, workspaceId, {
          lastInboundAt: occurredAt.toISOString(),
          lastMessageAt: occurredAt.toISOString(),
          lastMessagePreview: previewText,
          unreadCount: ((current?.unreadCount as number | undefined) ?? 0) + 1,
        })
      },
      touchOutbound: async (workspaceId, conversationId, occurredAt, previewText) => {
        conversations.update(conversationId, workspaceId, {
          lastOutboundAt: occurredAt.toISOString(),
          lastMessageAt: occurredAt.toISOString(),
          lastMessagePreview: previewText,
        })
      },
      markRead: async (workspaceId, conversationId) => {
        conversations.update(conversationId, workspaceId, { unreadCount: 0 })
      },
      softDelete: async (workspaceId, id) => {
        conversations.remove(id, workspaceId)
      },
    },
    messages: {
      list: async (workspaceId, conversationId, opts) => {
        const rows = messages.list(workspaceId).filter((m) => m.conversationId === conversationId)
        const limit = opts.limit ?? 50
        return {
          data: rows.slice(0, limit) as unknown as WhatsAppMessageRecord[],
          pagination: { nextCursor: null, limit },
        }
      },
      findById: async (workspaceId, id) => {
        const row = messages.get(id, workspaceId)
        return (row as unknown as WhatsAppMessageRecord) ?? null
      },
      findByProviderMessageId: async (workspaceId, providerMessageId) => {
        const row = messages
          .list(workspaceId)
          .find((m) => m.providerMessageId === providerMessageId)
        return (row as unknown as WhatsAppMessageRecord) ?? null
      },
      create: async (workspaceId, input, actorId) => {
        const rec = input as Record<string, unknown>
        const row = messages.insert({
          ...makeBaseRecord({
            workspaceId,
            ...(actorId ? { createdBy: actorId, updatedBy: actorId } : {}),
          }),
          conversationId: rec.conversationId,
          direction: rec.direction,
          kind: rec.kind ?? "text",
          body: rec.body ?? null,
          templateId: rec.templateId ?? null,
          templateVariables: rec.templateVariables ?? null,
          providerMessageId: rec.providerMessageId ?? null,
          status: rec.status ?? "queued",
          statusUpdatedAt: new Date().toISOString(),
          sentAt: null,
          deliveredAt: null,
          readAt: null,
          error: null,
        })
        return row as unknown as WhatsAppMessageRecord
      },
      update: async (workspaceId, id, patch) => {
        const next: Record<string, unknown> = {}
        if ("providerMessageId" in patch) next.providerMessageId = patch.providerMessageId
        if ("status" in patch) {
          const occurredAt = (patch.occurredAt as Date | undefined) ?? new Date()
          next.status = patch.status
          next.statusUpdatedAt = occurredAt.toISOString()
          if (patch.status === "sent") next.sentAt = occurredAt.toISOString()
          if (patch.status === "delivered") next.deliveredAt = occurredAt.toISOString()
          if (patch.status === "read") next.readAt = occurredAt.toISOString()
        }
        if ("error" in patch) next.error = patch.error
        const row = messages.update(id, workspaceId, next as Partial<StoredMessage>)
        return (row as unknown as WhatsAppMessageRecord) ?? null
      },
      recordInbound: async (workspaceId, input, actorId) => {
        const rec = input as Record<string, unknown>
        const providerMessageId = rec.providerMessageId as string | undefined
        if (providerMessageId) {
          const existing = messages
            .list(workspaceId)
            .find((m) => m.providerMessageId === providerMessageId)
          if (existing)
            return { record: existing as unknown as WhatsAppMessageRecord, created: false }
        }
        const row = messages.insert({
          ...makeBaseRecord({
            workspaceId,
            ...(actorId ? { createdBy: actorId, updatedBy: actorId } : {}),
          }),
          conversationId: rec.conversationId,
          direction: "inbound",
          kind: rec.kind ?? "text",
          body: rec.body ?? null,
          templateId: null,
          templateVariables: null,
          providerMessageId: providerMessageId ?? null,
          status: rec.status ?? "delivered",
          statusUpdatedAt: new Date().toISOString(),
          sentAt: null,
          deliveredAt: null,
          readAt: null,
          error: null,
        })
        return { record: row as unknown as WhatsAppMessageRecord, created: true }
      },
      applyStatus: async (workspaceId, providerMessageId, status, patch = {}) => {
        const current = messages
          .list(workspaceId)
          .find((m) => m.providerMessageId === providerMessageId)
        if (!current) return null
        if (STATUS_RANK[status]! <= STATUS_RANK[current.status as string]!) {
          return { record: current as unknown as WhatsAppMessageRecord, applied: false }
        }
        const occurredAt = patch.occurredAt ?? new Date()
        const next: Record<string, unknown> = { status, statusUpdatedAt: occurredAt.toISOString() }
        if (status === "sent") next.sentAt = occurredAt.toISOString()
        if (status === "delivered") next.deliveredAt = occurredAt.toISOString()
        if (status === "read") next.readAt = occurredAt.toISOString()
        if (patch.error !== undefined) next.error = patch.error
        const updated = messages.update(current.id, workspaceId, next as Partial<StoredMessage>)
        return { record: updated as unknown as WhatsAppMessageRecord, applied: true }
      },
    },
    templates: {
      list: async (workspaceId, opts) => {
        let rows = templates.list(workspaceId)
        if (opts.connectionId) rows = rows.filter((t) => t.connectionId === opts.connectionId)
        return {
          data: rows as unknown as WhatsAppTemplateRecord[],
          pagination: { nextCursor: null, limit: opts.limit ?? 25 },
        }
      },
      findById: async (workspaceId, id) => {
        const row = templates.get(id, workspaceId)
        return (row as unknown as WhatsAppTemplateRecord) ?? null
      },
      create: async (workspaceId, input, actorId) => {
        const rec = input as Record<string, unknown>
        const row = templates.insert({
          ...makeBaseRecord({
            workspaceId,
            ...(actorId ? { createdBy: actorId, updatedBy: actorId } : {}),
          }),
          connectionId: rec.connectionId,
          name: rec.name,
          language: rec.language ?? "en_US",
          category: rec.category ?? null,
          status: rec.status ?? "approved",
          bodyText: rec.bodyText,
          variableCount: rec.variableCount ?? 0,
        })
        return row as unknown as WhatsAppTemplateRecord
      },
    },
    connections,
    provider,
    audit: async () => undefined,
  })
}

function makeTestApp(session: { current: Session | null }, service: WhatsAppService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/whatsapp", createRoutes({ service }))
  return app
}

describe("api/whatsapp", () => {
  let session: { current: Session | null }
  let service: WhatsAppService
  let owner: Session
  let workspaceId: string

  beforeEach(() => {
    owner = makeSession({ role: "owner" })
    // `Session.workspaceId` is optional on the type (a session can have no
    // active workspace); `makeSession()` always sets one in practice.
    workspaceId = owner.workspaceId ?? nextId("ws")
    session = { current: owner }
    service = makeFakeService(workspaceId)
  })

  test("unauthenticated requests get UNAUTHORIZED", async () => {
    session.current = null
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/whatsapp/conversations")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("viewer can list/get but is forbidden from creating a conversation", async () => {
    session.current = makeSession({ role: "viewer" })
    const api = createApiClient({ app: makeTestApp(session, service), session: session.current })
    const list = await api.get("/api/v1/whatsapp/conversations")
    expect(list.status).toBe(200)
    const created = await api.post("/api/v1/whatsapp/conversations", {
      connectionId: CONNECTION_ID,
      contactPhone: "+14155552671",
    })
    expect(created.status).toBe(403)
    created.expectError("FORBIDDEN")
  })

  test("create, get and list a conversation", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const created = await api.post("/api/v1/whatsapp/conversations", {
      connectionId: CONNECTION_ID,
      contactPhone: "+14155552671",
    })
    expect(created.status).toBe(201)
    const id = (created.expectSuccess().data as { id: string }).id

    const fetched = await api.get(`/api/v1/whatsapp/conversations/${id}`)
    expect(fetched.status).toBe(200)
    expect((fetched.expectSuccess().data as { contactPhone: string }).contactPhone).toBe(
      "+14155552671",
    )

    const list = await api.get("/api/v1/whatsapp/conversations")
    const listed = list.expectSuccess()
    expect(Array.isArray(listed.data)).toBe(true)
    expect(listed.pagination?.limit).toBe(25)
  })

  test("an unknown conversation id is a 404", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const res = await api.get("/api/v1/whatsapp/conversations/missing")
    expect(res.status).toBe(404)
    res.expectError("NOT_FOUND")
  })

  test("updateConversation links a person", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const created = await api.post("/api/v1/whatsapp/conversations", {
      connectionId: CONNECTION_ID,
      contactPhone: "+14155552671",
    })
    const id = (created.expectSuccess().data as { id: string }).id
    const updated = await api.patch(`/api/v1/whatsapp/conversations/${id}`, {
      personId: "person-1",
    })
    expect(updated.status).toBe(200)
    expect((updated.expectSuccess().data as { personId: string }).personId).toBe("person-1")
  })

  test("free text outside the 24h session window is rejected with 409", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const created = await api.post("/api/v1/whatsapp/conversations", {
      connectionId: CONNECTION_ID,
      contactPhone: "+14155552671",
    })
    const id = (created.expectSuccess().data as { id: string }).id
    const res = await api.post(`/api/v1/whatsapp/conversations/${id}/messages`, {
      kind: "text",
      body: "Hello!",
    })
    expect(res.status).toBe(409)
    res.expectError("WHATSAPP_SESSION_WINDOW_CLOSED")
  })

  test("free text inside the 24h session window is sent and returns 201", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const created = await api.post("/api/v1/whatsapp/conversations", {
      connectionId: CONNECTION_ID,
      contactPhone: "+14155552671",
    })
    const id = (created.expectSuccess().data as { id: string }).id
    await service.ingestInboundMessage({
      workspaceId,
      connectionId: CONNECTION_ID,
      from: "+14155552671",
      providerMessageId: "wamid.in.1",
      text: "hi",
      occurredAt: new Date(),
    })
    const res = await api.post(`/api/v1/whatsapp/conversations/${id}/messages`, {
      kind: "text",
      body: "Hello!",
    })
    expect(res.status).toBe(201)
    const data = res.expectSuccess().data as { status: string; providerMessageId: string }
    expect(data.status).toBe("sent")
    expect(data.providerMessageId).toBeTruthy()
  })

  test("sending requires send_external — a viewer is denied even inside the window", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const created = await api.post("/api/v1/whatsapp/conversations", {
      connectionId: CONNECTION_ID,
      contactPhone: "+14155552671",
    })
    const id = (created.expectSuccess().data as { id: string }).id
    await service.ingestInboundMessage({
      workspaceId,
      connectionId: CONNECTION_ID,
      from: "+14155552671",
      providerMessageId: "wamid.in.2",
      text: "hi",
      occurredAt: new Date(),
    })
    session.current = makeSession({ role: "viewer", workspaceId })
    const viewerApi = createApiClient({
      app: makeTestApp(session, service),
      session: session.current,
    })
    const res = await viewerApi.post(`/api/v1/whatsapp/conversations/${id}/messages`, {
      kind: "text",
      body: "Hello!",
    })
    expect(res.status).toBe(403)
    res.expectError("FORBIDDEN")
  })

  test("create a template, then send it outside the window and succeed", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const template = await api.post("/api/v1/whatsapp/templates", {
      connectionId: CONNECTION_ID,
      name: "order_update",
      bodyText: "Your order {{1}} has shipped",
    })
    expect(template.status).toBe(201)
    const templateId = (template.expectSuccess().data as { id: string }).id

    const created = await api.post("/api/v1/whatsapp/conversations", {
      connectionId: CONNECTION_ID,
      contactPhone: "+14155552671",
    })
    const id = (created.expectSuccess().data as { id: string }).id

    const res = await api.post(`/api/v1/whatsapp/conversations/${id}/messages`, {
      kind: "template",
      templateId,
      variables: ["A100"],
    })
    expect(res.status).toBe(201)
    const data = res.expectSuccess().data as { status: string; body: string }
    expect(data.status).toBe("sent")
    expect(data.body).toBe("Your order A100 has shipped")
  })

  test("marking a conversation read resets unreadCount", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const created = await api.post("/api/v1/whatsapp/conversations", {
      connectionId: CONNECTION_ID,
      contactPhone: "+14155552671",
    })
    const id = (created.expectSuccess().data as { id: string }).id
    await service.ingestInboundMessage({
      workspaceId,
      connectionId: CONNECTION_ID,
      from: "+14155552671",
      providerMessageId: "wamid.in.3",
      text: "hi",
      occurredAt: new Date(),
    })
    const res = await api.post(`/api/v1/whatsapp/conversations/${id}/read`)
    expect(res.status).toBe(200)
    expect((res.expectSuccess().data as { unreadCount: number }).unreadCount).toBe(0)
  })

  test("invalid bodies are rejected with VALIDATION_ERROR", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const res = await api.post("/api/v1/whatsapp/conversations", { connectionId: "" })
    expect(res.status).toBe(400)
    res.expectError("VALIDATION_ERROR")
  })
})
