import { describe, expect, test } from "bun:test"
import {
  captureEvents,
  createStore,
  expectAllowed,
  expectDenied,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
  nextId,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import {
  createWhatsAppService,
  WhatsAppConversationNotFoundError,
  WhatsAppNotConnectedError,
  WhatsAppSendFailedError,
  WhatsAppSessionWindowClosedError,
  WhatsAppTemplateNotApprovedError,
  WhatsAppTemplateNotFoundError,
} from "./service"
import { WHATSAPP_SESSION_WINDOW_MS } from "./session-window"
import type {
  WhatsAppAuditInput,
  WhatsAppConnectionPort,
  WhatsAppConnectionRecord,
  WhatsAppConversationRecord,
  WhatsAppMessageRecord,
  WhatsAppProviderAdapter,
  WhatsAppServiceContext,
  WhatsAppTemplateRecord,
} from "./types"

const CONNECTION_ID = "conn-1"
const API_KEY = "dev-secret-0123456789"

type StoredConversation = BaseRecord & {
  connectionId: string
  contactPhone: string
  personId: string | null
  companyId: string | null
  status: string
  lastInboundAt: string | null
  lastOutboundAt: string | null
  lastMessageAt: string | null
  lastMessagePreview: string | null
  unreadCount: number
}

type StoredMessage = BaseRecord & {
  conversationId: string
  direction: string
  kind: string
  body: string | null
  templateId: string | null
  templateVariables: string[] | null
  providerMessageId: string | null
  status: string
  statusUpdatedAt: string | null
  sentAt: string | null
  deliveredAt: string | null
  readAt: string | null
  error: string | null
}

type StoredTemplate = BaseRecord & {
  connectionId: string
  name: string
  language: string
  category: string | null
  status: string
  bodyText: string
  variableCount: number
}

const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, failed: 2, delivered: 3, read: 4 }

function asConversation(row: StoredConversation): WhatsAppConversationRecord {
  return row as unknown as WhatsAppConversationRecord
}
function asMessage(row: StoredMessage): WhatsAppMessageRecord {
  return row as unknown as WhatsAppMessageRecord
}
function asTemplate(row: StoredTemplate): WhatsAppTemplateRecord {
  return row as unknown as WhatsAppTemplateRecord
}

/** Hermetic in-memory harness: real domain service over fake stores/provider. */
function makeHarness(opts: { sendShouldFail?: boolean } = {}) {
  const conversations = createStore<StoredConversation>()
  const messages = createStore<StoredMessage>()
  const templates = createStore<StoredTemplate>()
  const connectionsById = new Map<string, WhatsAppConnectionRecord>()
  const secrets = new Map<string, string>()
  const audits: WhatsAppAuditInput[] = []
  const clock = { current: new Date("2026-01-01T00:00:00.000Z") }
  let sendShouldFail = opts.sendShouldFail ?? false

  const connectionPort: WhatsAppConnectionPort = {
    findById: async (workspaceId, id) => {
      const row = connectionsById.get(id)
      return row && row.workspaceId === workspaceId ? row : null
    },
    readSecret: async (_workspaceId, id) => secrets.get(id) ?? null,
  }

  const provider: WhatsAppProviderAdapter = {
    sendText: async (input) => {
      if (sendShouldFail) throw new Error(`boom while sending, secret was ${input.secret}`)
      return { providerMessageId: nextId("prov") }
    },
    sendTemplate: async (input) => {
      if (sendShouldFail) throw new Error(`boom while sending, secret was ${input.secret}`)
      return { providerMessageId: nextId("prov") }
    },
  }

  const service = createWhatsAppService({
    conversations: {
      list: async (workspaceId, query) => {
        let rows = conversations.list(workspaceId)
        if (query.status) rows = rows.filter((r) => r.status === query.status)
        if (query.connectionId) rows = rows.filter((r) => r.connectionId === query.connectionId)
        const limit = query.limit ?? 25
        return { data: rows.slice(0, limit).map(asConversation), pagination: { nextCursor: null, limit } }
      },
      findById: async (workspaceId, id) => {
        const row = conversations.get(id, workspaceId)
        return row ? asConversation(row) : null
      },
      findOrCreate: async (workspaceId, input, actorId) => {
        const rec = input as { connectionId: string; contactPhone: string; personId?: string | null; companyId?: string | null }
        const existing = conversations
          .list(workspaceId)
          .find((r) => r.connectionId === rec.connectionId && r.contactPhone === rec.contactPhone)
        if (existing) return { record: asConversation(existing), created: false }
        const row = conversations.insert({
          ...makeBaseRecord({ workspaceId, ...(actorId ? { createdBy: actorId, updatedBy: actorId } : {}) }),
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
        return { record: asConversation(row), created: true }
      },
      update: async (workspaceId, id, patch) => {
        const row = conversations.update(id, workspaceId, patch as Partial<StoredConversation>)
        return row ? asConversation(row) : null
      },
      touchInbound: async (workspaceId, conversationId, occurredAt, previewText) => {
        const current = conversations.get(conversationId, workspaceId)
        conversations.update(conversationId, workspaceId, {
          lastInboundAt: occurredAt.toISOString(),
          lastMessageAt: occurredAt.toISOString(),
          lastMessagePreview: previewText,
          unreadCount: (current?.unreadCount ?? 0) + 1,
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
      list: async (workspaceId, conversationId, opts2) => {
        const rows = messages.list(workspaceId).filter((m) => m.conversationId === conversationId)
        const limit = opts2.limit ?? 50
        return { data: rows.slice(0, limit).map(asMessage), pagination: { nextCursor: null, limit } }
      },
      findById: async (workspaceId, id) => {
        const row = messages.get(id, workspaceId)
        return row ? asMessage(row) : null
      },
      findByProviderMessageId: async (workspaceId, providerMessageId) => {
        const row = messages.list(workspaceId).find((m) => m.providerMessageId === providerMessageId)
        return row ? asMessage(row) : null
      },
      create: async (workspaceId, input, actorId) => {
        const rec = input as Record<string, unknown>
        const row = messages.insert({
          ...makeBaseRecord({ workspaceId, ...(actorId ? { createdBy: actorId, updatedBy: actorId } : {}) }),
          conversationId: rec.conversationId as string,
          direction: rec.direction as string,
          kind: (rec.kind as string) ?? "text",
          body: (rec.body as string | null) ?? null,
          templateId: (rec.templateId as string | null) ?? null,
          templateVariables: (rec.templateVariables as string[] | null) ?? null,
          providerMessageId: (rec.providerMessageId as string | null) ?? null,
          status: (rec.status as string) ?? "queued",
          statusUpdatedAt: new Date().toISOString(),
          sentAt: null,
          deliveredAt: null,
          readAt: null,
          error: null,
        })
        return asMessage(row)
      },
      update: async (workspaceId, id, patch) => {
        const next: Partial<StoredMessage> = {}
        if ("providerMessageId" in patch) next.providerMessageId = patch.providerMessageId as string | null
        if ("status" in patch) {
          const occurredAt = (patch.occurredAt as Date | undefined) ?? new Date()
          next.status = patch.status as string
          next.statusUpdatedAt = occurredAt.toISOString()
          if (patch.status === "sent") next.sentAt = occurredAt.toISOString()
          if (patch.status === "delivered") next.deliveredAt = occurredAt.toISOString()
          if (patch.status === "read") next.readAt = occurredAt.toISOString()
        }
        if ("error" in patch) next.error = patch.error as string | null
        const row = messages.update(id, workspaceId, next)
        return row ? asMessage(row) : null
      },
      recordInbound: async (workspaceId, input, actorId) => {
        const rec = input as Record<string, unknown>
        const providerMessageId = rec.providerMessageId as string | undefined
        if (providerMessageId) {
          const existing = messages.list(workspaceId).find((m) => m.providerMessageId === providerMessageId)
          if (existing) return { record: asMessage(existing), created: false }
        }
        const row = messages.insert({
          ...makeBaseRecord({ workspaceId, ...(actorId ? { createdBy: actorId, updatedBy: actorId } : {}) }),
          conversationId: rec.conversationId as string,
          direction: "inbound",
          kind: (rec.kind as string) ?? "text",
          body: (rec.body as string | null) ?? null,
          templateId: null,
          templateVariables: null,
          providerMessageId: providerMessageId ?? null,
          status: (rec.status as string) ?? "delivered",
          statusUpdatedAt: new Date().toISOString(),
          sentAt: null,
          deliveredAt: null,
          readAt: null,
          error: null,
        })
        return { record: asMessage(row), created: true }
      },
      applyStatus: async (workspaceId, providerMessageId, status, patch = {}) => {
        const current = messages.list(workspaceId).find((m) => m.providerMessageId === providerMessageId)
        if (!current) return null
        if (STATUS_RANK[status]! <= STATUS_RANK[current.status]!) {
          return { record: asMessage(current), applied: false }
        }
        const occurredAt = patch.occurredAt ?? new Date()
        const next: Partial<StoredMessage> = { status, statusUpdatedAt: occurredAt.toISOString() }
        if (status === "sent") next.sentAt = occurredAt.toISOString()
        if (status === "delivered") next.deliveredAt = occurredAt.toISOString()
        if (status === "read") next.readAt = occurredAt.toISOString()
        if (patch.error !== undefined) next.error = patch.error
        const updated = messages.update(current.id, workspaceId, next)
        return { record: asMessage(updated!), applied: true }
      },
    },
    templates: {
      list: async (workspaceId, opts2) => {
        let rows = templates.list(workspaceId)
        if (opts2.connectionId) rows = rows.filter((t) => t.connectionId === opts2.connectionId)
        return { data: rows.map(asTemplate), pagination: { nextCursor: null, limit: opts2.limit ?? 25 } }
      },
      findById: async (workspaceId, id) => {
        const row = templates.get(id, workspaceId)
        return row ? asTemplate(row) : null
      },
      create: async (workspaceId, input, actorId) => {
        const rec = input as Record<string, unknown>
        const row = templates.insert({
          ...makeBaseRecord({ workspaceId, ...(actorId ? { createdBy: actorId, updatedBy: actorId } : {}) }),
          connectionId: rec.connectionId as string,
          name: rec.name as string,
          language: (rec.language as string) ?? "en_US",
          category: (rec.category as string | null) ?? null,
          status: (rec.status as string) ?? "approved",
          bodyText: rec.bodyText as string,
          variableCount: (rec.variableCount as number) ?? 0,
        })
        return asTemplate(row)
      },
    },
    connections: connectionPort,
    provider,
    audit: async (input) => void audits.push(input),
    now: () => clock.current,
  })

  return {
    service,
    audits,
    conversations,
    messages,
    templates,
    connectionsById,
    secrets,
    clock,
    setSendShouldFail: (value: boolean) => {
      sendShouldFail = value
    },
  }
}

function connectConnection(h: ReturnType<typeof makeHarness>, workspaceId: string) {
  h.connectionsById.set(CONNECTION_ID, {
    id: CONNECTION_ID,
    workspaceId,
    providerId: "whatsapp-console",
    status: "connected",
    config: {},
  })
  h.secrets.set(CONNECTION_ID, API_KEY)
}

function ctxOf(role: "owner" | "admin" | "member" | "viewer" = "owner", workspaceId?: string): WhatsAppServiceContext {
  const session = makeSession({ role, ...(workspaceId ? { workspaceId } : {}) })
  return makeServiceContext({ session })
}

describe("whatsapp/service", () => {
  describe("conversations", () => {
    test("createConversation opens a conversation and audits it", async () => {
      const h = makeHarness()
      const ctx = ctxOf("owner")
      connectConnection(h, ctx.workspaceId)
      const conversation = await expectAllowed(() =>
        h.service.createConversation(ctx, { connectionId: CONNECTION_ID, contactPhone: "+14155552671" }),
      )
      expect(conversation.contactPhone).toBe("+14155552671")
      expect(h.audits.at(-1)).toMatchObject({ action: "create", object: "whatsapp_conversation" })
    })

    test("createConversation is idempotent per (connection, phone)", async () => {
      const h = makeHarness()
      const ctx = ctxOf("owner")
      const first = await h.service.createConversation(ctx, {
        connectionId: CONNECTION_ID,
        contactPhone: "+14155552671",
      })
      const second = await h.service.createConversation(ctx, {
        connectionId: CONNECTION_ID,
        contactPhone: "+14155552671",
      })
      expect(second.id).toBe(first.id)
    })

    test("updateConversation links a person and audits before/after", async () => {
      const h = makeHarness()
      const ctx = ctxOf("owner")
      const created = await h.service.createConversation(ctx, {
        connectionId: CONNECTION_ID,
        contactPhone: "+14155552671",
      })
      const updated = await expectAllowed(() =>
        h.service.updateConversation(ctx, created.id, { personId: "person-1" }),
      )
      expect(updated.personId).toBe("person-1")
      expect(h.audits.at(-1)).toMatchObject({ action: "update", recordId: created.id })
    })

    test("getConversation throws NOT_FOUND for an unknown id", async () => {
      const h = makeHarness()
      const ctx = ctxOf("owner")
      const err = await h.service.getConversation(ctx, "missing").catch((e: unknown) => e)
      expect(err).toBeInstanceOf(WhatsAppConversationNotFoundError)
      expect((err as { code?: string }).code).toBe("NOT_FOUND")
    })

    test("viewer can list and get (read is open) but cannot create", async () => {
      const h = makeHarness()
      const owner = ctxOf("owner")
      const created = await h.service.createConversation(owner, {
        connectionId: CONNECTION_ID,
        contactPhone: "+14155552671",
      })
      const viewer = ctxOf("viewer", owner.workspaceId)
      await expectAllowed(() => h.service.listConversations(viewer, {}))
      await expectAllowed(() => h.service.getConversation(viewer, created.id))
      await expectDenied(() =>
        h.service.createConversation(viewer, { connectionId: CONNECTION_ID, contactPhone: "+1" }),
      )
    })
  })

  describe("the 24h session window", () => {
    test("free text is rejected with no prior inbound message at all", async () => {
      const h = makeHarness()
      const ctx = ctxOf("owner")
      connectConnection(h, ctx.workspaceId)
      const conversation = await h.service.createConversation(ctx, {
        connectionId: CONNECTION_ID,
        contactPhone: "+14155552671",
      })
      await expect(
        h.service.sendMessage(ctx, conversation.id, { kind: "text", body: "Hi there" }),
      ).rejects.toBeInstanceOf(WhatsAppSessionWindowClosedError)
    })

    test("free text is allowed just inside the 24h window", async () => {
      const h = makeHarness()
      const ctx = ctxOf("owner")
      connectConnection(h, ctx.workspaceId)
      const { conversation } = await h.service.ingestInboundMessage({
        workspaceId: ctx.workspaceId,
        connectionId: CONNECTION_ID,
        from: "+14155552671",
        providerMessageId: "wamid.in.1",
        text: "hello",
        occurredAt: h.clock.current,
      })
      h.clock.current = new Date(h.clock.current.getTime() + WHATSAPP_SESSION_WINDOW_MS - 1)
      const sent = await expectAllowed(() =>
        h.service.sendMessage(ctx, conversation.id, { kind: "text", body: "Still in time" }),
      )
      expect(sent.status).toBe("sent")
      expect(sent.providerMessageId).toBeTruthy()
    })

    test("free text is rejected exactly at (and past) the 24h boundary", async () => {
      const h = makeHarness()
      const ctx = ctxOf("owner")
      connectConnection(h, ctx.workspaceId)
      const { conversation } = await h.service.ingestInboundMessage({
        workspaceId: ctx.workspaceId,
        connectionId: CONNECTION_ID,
        from: "+14155552671",
        providerMessageId: "wamid.in.2",
        text: "hello",
        occurredAt: h.clock.current,
      })
      h.clock.current = new Date(h.clock.current.getTime() + WHATSAPP_SESSION_WINDOW_MS)
      await expect(
        h.service.sendMessage(ctx, conversation.id, { kind: "text", body: "Too late" }),
      ).rejects.toBeInstanceOf(WhatsAppSessionWindowClosedError)
    })

    test("an approved template is always allowed, even with the window closed", async () => {
      const h = makeHarness()
      const ctx = ctxOf("owner")
      connectConnection(h, ctx.workspaceId)
      const conversation = await h.service.createConversation(ctx, {
        connectionId: CONNECTION_ID,
        contactPhone: "+14155552671",
      })
      const template = await h.service.createTemplate(ctx, {
        connectionId: CONNECTION_ID,
        name: "order_update",
        bodyText: "Your order {{1}} has shipped",
      })
      const sent = await expectAllowed(() =>
        h.service.sendMessage(ctx, conversation.id, {
          kind: "template",
          templateId: template.id,
          variables: ["A100"],
        }),
      )
      expect(sent.status).toBe("sent")
      expect(sent.kind).toBe("template")
      expect(sent.body).toBe("Your order A100 has shipped")
    })

    test("an unapproved template cannot be sent", async () => {
      const h = makeHarness()
      const ctx = ctxOf("owner")
      connectConnection(h, ctx.workspaceId)
      const conversation = await h.service.createConversation(ctx, {
        connectionId: CONNECTION_ID,
        contactPhone: "+14155552671",
      })
      const template = await h.templates.insert({
        ...makeBaseRecord({ workspaceId: ctx.workspaceId }),
        connectionId: CONNECTION_ID,
        name: "pending_tpl",
        language: "en_US",
        category: null,
        status: "pending",
        bodyText: "Hi {{1}}",
        variableCount: 1,
      })
      await expect(
        h.service.sendMessage(ctx, conversation.id, {
          kind: "template",
          templateId: template.id,
          variables: ["A"],
        }),
      ).rejects.toBeInstanceOf(WhatsAppTemplateNotApprovedError)
    })

    test("an unknown template id is NOT_FOUND", async () => {
      const h = makeHarness()
      const ctx = ctxOf("owner")
      connectConnection(h, ctx.workspaceId)
      const conversation = await h.service.createConversation(ctx, {
        connectionId: CONNECTION_ID,
        contactPhone: "+14155552671",
      })
      await expect(
        h.service.sendMessage(ctx, conversation.id, {
          kind: "template",
          templateId: "missing",
          variables: [],
        }),
      ).rejects.toBeInstanceOf(WhatsAppTemplateNotFoundError)
    })
  })

  describe("sendMessage", () => {
    test("requires send_external — a viewer is denied", async () => {
      const h = makeHarness()
      const owner = ctxOf("owner")
      connectConnection(h, owner.workspaceId)
      const { conversation } = await h.service.ingestInboundMessage({
        workspaceId: owner.workspaceId,
        connectionId: CONNECTION_ID,
        from: "+14155552671",
        providerMessageId: "wamid.in.3",
        text: "hi",
        occurredAt: h.clock.current,
      })
      const viewer = ctxOf("viewer", owner.workspaceId)
      await expectDenied(() => h.service.sendMessage(viewer, conversation.id, { kind: "text", body: "Hey" }))
    })

    test("a member (not just admin/owner) can send — rank 40 is enough", async () => {
      const h = makeHarness()
      const owner = ctxOf("owner")
      connectConnection(h, owner.workspaceId)
      const { conversation } = await h.service.ingestInboundMessage({
        workspaceId: owner.workspaceId,
        connectionId: CONNECTION_ID,
        from: "+14155552671",
        providerMessageId: "wamid.in.4",
        text: "hi",
        occurredAt: h.clock.current,
      })
      const member = ctxOf("member", owner.workspaceId)
      await expectAllowed(() => h.service.sendMessage(member, conversation.id, { kind: "text", body: "Hey" }))
    })

    test("emits message.sent and writes a success audit row", async () => {
      const h = makeHarness()
      const ctx = ctxOf("owner")
      connectConnection(h, ctx.workspaceId)
      const { conversation } = await h.service.ingestInboundMessage({
        workspaceId: ctx.workspaceId,
        connectionId: CONNECTION_ID,
        from: "+14155552671",
        providerMessageId: "wamid.in.5",
        text: "hi",
        occurredAt: h.clock.current,
      })
      const events = captureEvents()
      try {
        const sent = await h.service.sendMessage(ctx, conversation.id, { kind: "text", body: "Hey" })
        events.expectEmitted("message.sent", { entityId: sent.id, workspaceId: ctx.workspaceId })
        expect(h.audits.at(-1)).toMatchObject({ action: "send", recordId: sent.id })
      } finally {
        events.release()
      }
    })

    test("without a connected integration, sending fails with WHATSAPP_NOT_CONNECTED", async () => {
      const h = makeHarness()
      const ctx = ctxOf("owner")
      // No connectConnection() call: the workspace has no live connection.
      const { conversation } = await h.service.ingestInboundMessage({
        workspaceId: ctx.workspaceId,
        connectionId: CONNECTION_ID,
        from: "+14155552671",
        providerMessageId: "wamid.in.6",
        text: "hi",
        occurredAt: h.clock.current,
      })
      await expect(
        h.service.sendMessage(ctx, conversation.id, { kind: "text", body: "Hey" }),
      ).rejects.toBeInstanceOf(WhatsAppNotConnectedError)
    })

    test("a provider failure marks the message failed, redacts the secret and throws", async () => {
      const h = makeHarness({ sendShouldFail: true })
      const ctx = ctxOf("owner")
      connectConnection(h, ctx.workspaceId)
      const { conversation } = await h.service.ingestInboundMessage({
        workspaceId: ctx.workspaceId,
        connectionId: CONNECTION_ID,
        from: "+14155552671",
        providerMessageId: "wamid.in.7",
        text: "hi",
        occurredAt: h.clock.current,
      })
      await expect(
        h.service.sendMessage(ctx, conversation.id, { kind: "text", body: "Hey" }),
      ).rejects.toBeInstanceOf(WhatsAppSendFailedError)

      const stored = h.messages.list(ctx.workspaceId).find((m) => m.conversationId === conversation.id && m.direction === "outbound")
      expect(stored?.status).toBe("failed")
      expect(stored?.error).not.toContain(API_KEY)
      expect(h.audits.at(-1)).toMatchObject({ action: "send_failed" })
    })
  })

  describe("inbound webhook processing (ingestInboundMessage)", () => {
    test("creates a conversation and message, emits message.received", async () => {
      const h = makeHarness()
      const workspaceId = "ws-inbound"
      const events = captureEvents()
      try {
        const { conversation, message, created } = await h.service.ingestInboundMessage({
          workspaceId,
          connectionId: CONNECTION_ID,
          from: "14155552671",
          providerMessageId: "wamid.abc",
          text: "Hello there",
          occurredAt: new Date("2026-01-02T00:00:00Z"),
        })
        expect(created).toBe(true)
        expect(conversation.contactPhone).toBe("14155552671")
        events.expectEmitted("message.received", { entityId: message.id, workspaceId })
        expect(h.audits.at(-1)).toMatchObject({ action: "receive", source: "integration" })
      } finally {
        events.release()
      }
    })

    test("is idempotent: replaying the same providerMessageId does not duplicate or re-emit", async () => {
      const h = makeHarness()
      const workspaceId = "ws-idem"
      const input = {
        workspaceId,
        connectionId: CONNECTION_ID,
        from: "+14155552671",
        providerMessageId: "wamid.replay",
        text: "Hello",
        occurredAt: new Date("2026-01-02T00:00:00Z"),
      }
      const first = await h.service.ingestInboundMessage(input)
      expect(first.created).toBe(true)
      const auditsAfterFirst = h.audits.length

      const second = await h.service.ingestInboundMessage(input)
      expect(second.created).toBe(false)
      expect(second.message.id).toBe(first.message.id)
      expect(h.audits.length).toBe(auditsAfterFirst)
    })
  })

  describe("inbound status webhooks (ingestStatusUpdate) — idempotent, out-of-order safe", () => {
    test("normal progression sent -> delivered -> read all apply", async () => {
      const h = makeHarness()
      const ctx = ctxOf("owner")
      connectConnection(h, ctx.workspaceId)
      const { conversation } = await h.service.ingestInboundMessage({
        workspaceId: ctx.workspaceId,
        connectionId: CONNECTION_ID,
        from: "+14155552671",
        providerMessageId: "wamid.in.8",
        text: "hi",
        occurredAt: h.clock.current,
      })
      const sent = await h.service.sendMessage(ctx, conversation.id, { kind: "text", body: "Hey" })
      const providerMessageId = sent.providerMessageId as string

      const delivered = await h.service.ingestStatusUpdate({
        workspaceId: ctx.workspaceId,
        providerMessageId,
        status: "delivered",
        occurredAt: new Date(h.clock.current.getTime() + 1_000),
      })
      expect(delivered?.applied).toBe(true)
      expect(delivered?.message.status).toBe("delivered")

      const read = await h.service.ingestStatusUpdate({
        workspaceId: ctx.workspaceId,
        providerMessageId,
        status: "read",
        occurredAt: new Date(h.clock.current.getTime() + 2_000),
      })
      expect(read?.applied).toBe(true)
      expect(read?.message.status).toBe("read")
    })

    test("a delivered webhook arriving after read does not regress the status", async () => {
      const h = makeHarness()
      const ctx = ctxOf("owner")
      connectConnection(h, ctx.workspaceId)
      const { conversation } = await h.service.ingestInboundMessage({
        workspaceId: ctx.workspaceId,
        connectionId: CONNECTION_ID,
        from: "+14155552671",
        providerMessageId: "wamid.in.9",
        text: "hi",
        occurredAt: h.clock.current,
      })
      const sent = await h.service.sendMessage(ctx, conversation.id, { kind: "text", body: "Hey" })
      const providerMessageId = sent.providerMessageId as string

      await h.service.ingestStatusUpdate({
        workspaceId: ctx.workspaceId,
        providerMessageId,
        status: "read",
        occurredAt: new Date(h.clock.current.getTime() + 5_000),
      })
      // Out-of-order redelivery: "delivered" lands AFTER "read" was already applied.
      const late = await h.service.ingestStatusUpdate({
        workspaceId: ctx.workspaceId,
        providerMessageId,
        status: "delivered",
        occurredAt: new Date(h.clock.current.getTime() + 1_000),
      })
      expect(late?.applied).toBe(false)
      expect(late?.message.status).toBe("read")
    })

    test("replaying the same status twice is a no-op the second time", async () => {
      const h = makeHarness()
      const ctx = ctxOf("owner")
      connectConnection(h, ctx.workspaceId)
      const { conversation } = await h.service.ingestInboundMessage({
        workspaceId: ctx.workspaceId,
        connectionId: CONNECTION_ID,
        from: "+14155552671",
        providerMessageId: "wamid.in.10",
        text: "hi",
        occurredAt: h.clock.current,
      })
      const sent = await h.service.sendMessage(ctx, conversation.id, { kind: "text", body: "Hey" })
      const providerMessageId = sent.providerMessageId as string

      const auditsBefore = h.audits.length
      await h.service.ingestStatusUpdate({
        workspaceId: ctx.workspaceId,
        providerMessageId,
        status: "delivered",
        occurredAt: new Date(),
      })
      const auditsAfterFirst = h.audits.length
      expect(auditsAfterFirst).toBe(auditsBefore + 1)

      const replay = await h.service.ingestStatusUpdate({
        workspaceId: ctx.workspaceId,
        providerMessageId,
        status: "delivered",
        occurredAt: new Date(),
      })
      expect(replay?.applied).toBe(false)
      expect(h.audits.length).toBe(auditsAfterFirst)
    })

    test("an unknown providerMessageId resolves to null without throwing", async () => {
      const h = makeHarness()
      const result = await h.service.ingestStatusUpdate({
        workspaceId: "ws-x",
        providerMessageId: "wamid.missing",
        status: "sent",
        occurredAt: new Date(),
      })
      expect(result).toBeNull()
    })
  })

  describe("templates", () => {
    test("createTemplate computes variableCount from {{n}} placeholders", async () => {
      const h = makeHarness()
      const ctx = ctxOf("owner")
      const template = await h.service.createTemplate(ctx, {
        connectionId: CONNECTION_ID,
        name: "shipping_update",
        bodyText: "Hi {{1}}, your order {{2}} shipped",
      })
      expect(template.variableCount).toBe(2)
    })
  })
})
