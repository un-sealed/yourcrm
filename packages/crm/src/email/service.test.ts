import { beforeEach, describe, expect, test } from "bun:test"
import {
  captureEvents,
  createStore,
  expectAllowed,
  expectDenied,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { createConsoleEmailProvider } from "./console-email-provider"
import {
  createEmailService,
  EmailConnectionUnavailableError,
  EmailSendFailedError,
  EmailThreadNotFoundError,
  type EmailService,
} from "./service"
import { createEmailTransportCatalog } from "./types"
import type {
  EmailAttachmentRecord,
  EmailAuditInput,
  EmailMessageDetail,
  EmailMessageRecord,
  EmailMessageStore,
  EmailParticipantRecord,
  EmailThreadListQuery,
  EmailThreadRecord,
  EmailThreadStore,
  EmailTransportPort,
} from "./types"

const CONNECTION_ID = "conn_email_1"
const DEV_SECRET = "dev-token-super-secret-value"

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
  fromName: string | null
  bodyText: string | null
  bodyHtml: string | null
  snippet: string | null
  connectionId: string | null
  providerId: string | null
  providerMessageId: string | null
  sentAt: Date | null
  receivedAt: Date | null
  lastError: string | null
  lastErrorAt: Date | null
  personId: string | null
  companyId: string | null
  dealId: string | null
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

function date(input: Record<string, unknown>, key: string): Date | null {
  const value = input[key]
  return value instanceof Date ? value : null
}

/**
 * Hermetic email stores: the four ports over the shared in-memory store,
 * including the two threading lookups (which is where the interesting
 * behaviour lives — see `threading.test.ts` for the algorithm in isolation).
 */
function makeEmailStores() {
  const threads = createStore<StoredThread>()
  const messages = createStore<StoredMessage>()
  const participants: (EmailParticipantRecord & {
    emailMessageId: string
    workspaceId: string
  })[] = []
  const attachments: (EmailAttachmentRecord & {
    emailMessageId: string
    workspaceId: string
  })[] = []

  const asThread = (row: StoredThread): EmailThreadRecord => row as unknown as EmailThreadRecord
  const asMessage = (row: StoredMessage): EmailMessageRecord => row as unknown as EmailMessageRecord

  const detailOf = (row: StoredMessage): EmailMessageDetail => ({
    message: asMessage(row),
    participants: participants.filter((p) => p.emailMessageId === row.id),
    attachments: attachments.filter((a) => a.emailMessageId === row.id),
  })

  const threadStore: EmailThreadStore = {
    list: async (workspaceId: string, query: EmailThreadListQuery) => {
      let rows = threads.list(workspaceId)
      if (query.status) rows = rows.filter((row) => row.status === query.status)
      if (query.personId) rows = rows.filter((row) => row.personId === query.personId)
      if (query.query) {
        const q = query.query.toLowerCase()
        rows = rows.filter((row) => (row.subject ?? "").toLowerCase().includes(q))
      }
      const limit = Math.min(Math.max(query.limit ?? 25, 1), 200)
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
      const rows = messages.list(workspaceId).filter((row) => row.threadId === id)
      return { thread: asThread(thread), messages: rows.map(detailOf) }
    },
    create: async (workspaceId, input, actorId) => {
      const row: StoredThread = {
        ...makeBaseRecord({ workspaceId }),
        subject: str(input, "subject"),
        normalizedSubject: str(input, "normalizedSubject") ?? "",
        participantKey: str(input, "participantKey") ?? "",
        status: str(input, "status") ?? "open",
        messageCount: 0,
        lastMessageAt: date(input, "lastMessageAt"),
        ownerId: str(input, "ownerId"),
        personId: str(input, "personId"),
        companyId: str(input, "companyId"),
        dealId: str(input, "dealId"),
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      }
      return asThread(threads.insert(row))
    },
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
        .filter(
          (row) =>
            row.normalizedSubject === match.normalizedSubject &&
            row.participantKey === match.participantKey &&
            (!match.activeSince ||
              (row.lastMessageAt ?? new Date(0)).getTime() >= match.activeSince.getTime()),
        )
      return found[0] ? { id: found[0].id } : null
    },
  }

  const messageStore: EmailMessageStore = {
    create: async (workspaceId, input, actorId) => {
      const row: StoredMessage = {
        ...makeBaseRecord({ workspaceId }),
        threadId: str(input, "threadId") ?? "",
        direction: str(input, "direction") ?? "outbound",
        status: str(input, "status") ?? "queued",
        messageId: str(input, "messageId"),
        inReplyTo: str(input, "inReplyTo"),
        referenceIds: strArray(input, "referenceIds"),
        subject: str(input, "subject"),
        fromAddress: str(input, "fromAddress"),
        fromName: str(input, "fromName"),
        bodyText: str(input, "bodyText"),
        bodyHtml: str(input, "bodyHtml"),
        snippet: str(input, "snippet"),
        connectionId: str(input, "connectionId"),
        providerId: str(input, "providerId"),
        providerMessageId: str(input, "providerMessageId"),
        sentAt: date(input, "sentAt"),
        receivedAt: date(input, "receivedAt"),
        lastError: str(input, "lastError"),
        lastErrorAt: date(input, "lastErrorAt"),
        personId: str(input, "personId"),
        companyId: str(input, "companyId"),
        dealId: str(input, "dealId"),
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      }
      const stored = messages.insert(row)
      const rawParticipants = input.participants
      if (Array.isArray(rawParticipants)) {
        for (const item of rawParticipants) {
          const record = item as Record<string, unknown>
          participants.push({
            id: `part_${participants.length + 1}`,
            emailMessageId: stored.id,
            workspaceId,
            role: str(record, "role") ?? "to",
            address: str(record, "address") ?? "",
            displayName: str(record, "displayName"),
            personId: null,
          })
        }
      }
      const rawAttachments = input.attachments
      if (Array.isArray(rawAttachments)) {
        for (const item of rawAttachments) {
          const record = item as Record<string, unknown>
          attachments.push({
            id: `att_${attachments.length + 1}`,
            emailMessageId: stored.id,
            workspaceId,
            fileName: str(record, "fileName") ?? "file",
            storageKey: str(record, "storageKey"),
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

  return { threads, messages, participants, attachments, threadStore, messageStore }
}

type SetupOptions = {
  role?: "owner" | "admin" | "member" | "viewer"
  /** Override the transport (failure injection). */
  transport?: EmailTransportPort
  /** No connected email integration in this workspace. */
  noConnection?: boolean
  workspaceId?: string
  backing?: ReturnType<typeof makeEmailStores>
}

let messageIdCounter = 0

function setup(options: SetupOptions = {}) {
  const session = makeSession({
    role: options.role ?? "owner",
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
  })
  const ctx = makeServiceContext({ session })
  const audits: EmailAuditInput[] = []
  const backing = options.backing ?? makeEmailStores()
  const provider = createConsoleEmailProvider({
    log: false,
    now: () => new Date("2026-03-01T10:00:00.000Z"),
  })
  const transport = options.transport ?? provider
  /** Every secret the transport was handed — proves the one-hop contract. */
  const secretsSeen: (string | null)[] = []

  const service = createEmailService({
    threads: backing.threadStore,
    messages: backing.messageStore,
    connections: {
      findSendable: async (workspaceId, connectionId) => {
        if (options.noConnection) return null
        if (workspaceId !== ctx.workspaceId) return null
        if (connectionId !== null && connectionId !== undefined && connectionId !== CONNECTION_ID) {
          return null
        }
        return {
          id: CONNECTION_ID,
          providerId: transport.id,
          config: { fromAddress: "sales@yourcrm.test", fromName: "YourCRM Sales" },
        }
      },
    },
    secrets: {
      readApiKey: async () => {
        return DEV_SECRET
      },
    },
    transports: {
      get: (providerId) => {
        const found = createEmailTransportCatalog([transport]).get(providerId)
        if (!found) return null
        return {
          id: found.id,
          sendEmail: async (input, transportCtx) => {
            secretsSeen.push(transportCtx.secret)
            return found.sendEmail(input, transportCtx)
          },
        }
      },
    },
    audit: async (input) => void audits.push(input),
    now: () => new Date("2026-03-01T10:00:00.000Z"),
    newMessageId: () => {
      messageIdCounter += 1
      return `out-${messageIdCounter}@yourcrm.test`
    },
  })

  return { ctx, service, audits, backing, provider, secretsSeen, session }
}

function sendInput(overrides: Record<string, unknown> = {}) {
  return {
    subject: "Q3 Budget",
    to: [{ address: "ada@example.com", name: "Ada" }],
    bodyText: "Numbers attached.",
    ...overrides,
  }
}

function inboundInput(workspaceId: string, overrides: Record<string, unknown> = {}) {
  return {
    workspaceId,
    connectionId: CONNECTION_ID,
    providerId: "console-email",
    messageId: "<in-1@example.com>",
    subject: "Q3 Budget",
    from: { address: "ada@example.com", name: "Ada" },
    to: [{ address: "sales@yourcrm.test" }],
    bodyText: "Here they are.",
    ...overrides,
  }
}

describe("email/service/permissions", () => {
  test("a viewer is DENIED send_external", async () => {
    const { ctx, service } = setup({ role: "viewer" })
    await expectDenied(() => service.sendMessage(ctx, sendInput()))
  })

  test("a viewer may still read threads", async () => {
    const { ctx, service } = setup({ role: "viewer" })
    const result = await expectAllowed(() => service.listThreads(ctx, {}))
    expect(result.data).toEqual([])
  })

  test("a viewer is denied linking a thread to a record", async () => {
    const backing = makeEmailStores()
    const owner = setup({ backing })
    const sent = await owner.service.sendMessage(owner.ctx, sendInput())
    const viewer = setup({
      backing,
      role: "viewer",
      workspaceId: owner.ctx.workspaceId,
    })
    await expectDenied(() =>
      viewer.service.updateThread(viewer.ctx, String(sent.message.threadId), {
        personId: "person_1",
      }),
    )
  })

  test("a member may send", async () => {
    const { ctx, service } = setup({ role: "member" })
    const sent = await expectAllowed(() => service.sendMessage(ctx, sendInput()))
    expect(sent.message.status).toBe("sent")
  })
})

describe("email/service/send", () => {
  test("stores the message, sends it and records the provider id + status", async () => {
    const { ctx, service, audits, provider, backing } = setup()
    const events = captureEvents()
    try {
      const sent = await service.sendMessage(ctx, sendInput())

      expect(sent.message.direction).toBe("outbound")
      expect(sent.message.status).toBe("sent")
      expect(sent.message.providerMessageId).toMatch(/^console-/)
      expect(sent.message.connectionId).toBe(CONNECTION_ID)
      expect(sent.message.sentAt).toEqual(new Date("2026-03-01T10:00:00.000Z"))
      expect(provider.outbox).toHaveLength(1)
      expect(provider.outbox[0]?.input.to[0]?.address).toBe("ada@example.com")

      // from/to/cc land as participant rows.
      expect(sent.participants.map((p) => `${p.role}:${p.address}`)).toEqual([
        "from:sales@yourcrm.test",
        "to:ada@example.com",
      ])

      // A thread was created and its counters rolled forward.
      const thread = backing.threads.get(String(sent.message.threadId), ctx.workspaceId)
      expect(thread?.messageCount).toBe(1)
      expect(thread?.lastMessageAt).toEqual(new Date("2026-03-01T10:00:00.000Z"))

      events.expectEmitted("email.sent", {
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "email_message",
        entityId: sent.message.id,
      })
      expect(audits.map((a) => a.action)).toContain("send")
    } finally {
      events.release()
    }
  })

  test("the default from address comes from the connection config", async () => {
    const { ctx, service } = setup()
    const sent = await service.sendMessage(ctx, sendInput())
    expect(sent.message.fromAddress).toBe("sales@yourcrm.test")
    expect(sent.message.fromName).toBe("YourCRM Sales")
  })

  test("the event and audit payloads carry no message body", async () => {
    const { ctx, service, audits } = setup()
    const events = captureEvents()
    try {
      await service.sendMessage(ctx, sendInput({ bodyText: "top secret pricing" }))
      const emitted = events.expectEmitted("email.sent")
      expect(JSON.stringify(emitted.after)).not.toContain("top secret pricing")
      expect(JSON.stringify(audits)).not.toContain("top secret pricing")
    } finally {
      events.release()
    }
  })

  test("the decrypted secret reaches the transport and nothing else", async () => {
    const { ctx, service, audits, secretsSeen, backing } = setup()
    const sent = await service.sendMessage(ctx, sendInput())
    expect(secretsSeen).toEqual([DEV_SECRET])
    // Not on the row, not in the audit trail, not in the returned payload.
    const stored = backing.messages.get(sent.message.id, ctx.workspaceId)
    expect(JSON.stringify(stored)).not.toContain(DEV_SECRET)
    expect(JSON.stringify(audits)).not.toContain(DEV_SECRET)
    expect(JSON.stringify(sent)).not.toContain(DEV_SECRET)
  })

  test("a provider failure marks the message failed and redacts the secret", async () => {
    const leaky: EmailTransportPort = {
      id: "leaky-provider",
      sendEmail: async () => {
        throw new Error(`upstream 401 for token ${DEV_SECRET}`)
      },
    }
    const { ctx, service, audits, backing } = setup({ transport: leaky })

    const err = await service.sendMessage(ctx, sendInput()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EmailSendFailedError)
    expect((err as Error).message).toContain("[redacted]")
    expect((err as Error).message).not.toContain(DEV_SECRET)

    const stored = backing.messages.list(ctx.workspaceId)[0]
    expect(stored?.status).toBe("failed")
    expect(stored?.lastError).toContain("[redacted]")
    expect(stored?.lastError).not.toContain(DEV_SECRET)
    expect(JSON.stringify(audits)).not.toContain(DEV_SECRET)
    expect(audits.map((a) => a.action)).toContain("send_failed")
  })

  test("no connected email integration is a clean domain error", async () => {
    const { ctx, service } = setup({ noConnection: true })
    await expect(service.sendMessage(ctx, sendInput())).rejects.toBeInstanceOf(
      EmailConnectionUnavailableError,
    )
  })

  test("an unknown explicit thread id is NOT_FOUND", async () => {
    const { ctx, service } = setup()
    await expect(
      service.sendMessage(ctx, sendInput({ threadId: "missing" })),
    ).rejects.toBeInstanceOf(EmailThreadNotFoundError)
  })

  test("a body-less message is rejected by validation", async () => {
    const { ctx, service } = setup()
    await expect(
      service.sendMessage(ctx, { subject: "hi", to: [{ address: "ada@example.com" }] }),
    ).rejects.toThrow()
  })

  test("html bodies are sanitised before they are stored", async () => {
    const { ctx, service, backing } = setup()
    const sent = await service.sendMessage(
      ctx,
      sendInput({ bodyText: "", bodyHtml: "<p>Hi</p><script>steal()</script>" }),
    )
    const stored = backing.messages.get(sent.message.id, ctx.workspaceId)
    expect(stored?.bodyHtml).toBe("<p>Hi</p>")
    expect(stored?.bodyText).toBe("Hi")
  })

  test("replying threads the outbound message onto its parent", async () => {
    const { ctx, service } = setup()
    const first = await service.sendMessage(ctx, sendInput())
    const reply = await service.sendMessage(
      ctx,
      sendInput({
        subject: "Re: Q3 Budget",
        replyToMessageId: first.message.id,
        bodyText: "One more thing.",
      }),
    )
    expect(reply.message.threadId).toBe(first.message.threadId)
    expect(reply.message.inReplyTo).toBe(String(first.message.messageId))
    expect(reply.message.referenceIds).toEqual([String(first.message.messageId)])
  })
})

describe("email/service/threads", () => {
  test("a thread can be linked to a person, company and deal", async () => {
    const { ctx, service, audits } = setup()
    const sent = await service.sendMessage(ctx, sendInput())
    const linked = await service.updateThread(ctx, String(sent.message.threadId), {
      personId: "person_1",
      companyId: "company_1",
      dealId: "deal_1",
    })
    expect(linked.personId).toBe("person_1")
    expect(linked.companyId).toBe("company_1")
    expect(linked.dealId).toBe("deal_1")
    expect(audits.some((a) => a.object === "email_thread" && a.action === "update")).toBe(true)
  })

  test("getThread returns the thread with its messages; unknown id is NOT_FOUND", async () => {
    const { ctx, service } = setup()
    const sent = await service.sendMessage(ctx, sendInput())
    const detail = await service.getThread(ctx, String(sent.message.threadId))
    expect(detail.messages).toHaveLength(1)
    await expect(service.getThread(ctx, "missing")).rejects.toBeInstanceOf(EmailThreadNotFoundError)
  })

  test("archiving a thread is an update, not a delete", async () => {
    const { ctx, service } = setup()
    const sent = await service.sendMessage(ctx, sendInput())
    const archived = await service.updateThread(ctx, String(sent.message.threadId), {
      status: "archived",
    })
    expect(archived.status).toBe("archived")
  })
})

describe("email/service/inbound", () => {
  let fixture: ReturnType<typeof setup>
  let service: EmailService

  beforeEach(() => {
    fixture = setup()
    service = fixture.service
  })

  test("an inbound message creates a thread and emits email.received", async () => {
    const events = captureEvents()
    try {
      const result = await service.receiveInboundEmail(inboundInput(fixture.ctx.workspaceId))
      expect(result.status).toBe("created")
      expect(result.threadReason).toBe("new")

      const stored = fixture.backing.messages.get(result.messageId, fixture.ctx.workspaceId)
      expect(stored?.direction).toBe("inbound")
      expect(stored?.status).toBe("received")
      expect(stored?.messageId).toBe("in-1@example.com")

      events.expectEmitted("email.received", {
        workspaceId: fixture.ctx.workspaceId,
        entityType: "email_message",
        entityId: result.messageId,
      })
      expect(fixture.audits.some((a) => a.action === "receive" && a.source === "integration")).toBe(
        true,
      )
    } finally {
      events.release()
    }
  })

  test("re-delivering the same Message-ID is idempotent", async () => {
    const events = captureEvents()
    try {
      const first = await service.receiveInboundEmail(inboundInput(fixture.ctx.workspaceId))
      const again = await service.receiveInboundEmail(inboundInput(fixture.ctx.workspaceId))

      expect(again.status).toBe("duplicate")
      expect(again.messageId).toBe(first.messageId)
      expect(again.threadId).toBe(first.threadId)
      expect(fixture.backing.messages.list(fixture.ctx.workspaceId)).toHaveLength(1)
      // The second delivery emits nothing and audits nothing.
      expect(events.count("email.received")).toBe(1)
      expect(fixture.audits.filter((a) => a.action === "receive")).toHaveLength(1)
    } finally {
      events.release()
    }
  })

  test("a 3-message reply chain lands in ONE thread", async () => {
    const ws = fixture.ctx.workspaceId
    const first = await service.receiveInboundEmail(
      inboundInput(ws, { messageId: "<m1@example.com>", subject: "Q3 Budget" }),
    )
    const second = await service.receiveInboundEmail(
      inboundInput(ws, {
        messageId: "<m2@example.com>",
        inReplyTo: "<m1@example.com>",
        references: "<m1@example.com>",
        subject: "Re: Q3 Budget",
      }),
    )
    const third = await service.receiveInboundEmail(
      inboundInput(ws, {
        messageId: "<m3@example.com>",
        inReplyTo: "<m2@example.com>",
        references: "<m1@example.com> <m2@example.com>",
        // Subject rewritten: the headers alone must hold the thread together.
        subject: "Q3 Budget — final",
        to: [{ address: "sales@yourcrm.test" }, { address: "cfo@yourcrm.test" }],
      }),
    )

    expect(second.threadId).toBe(first.threadId)
    expect(third.threadId).toBe(first.threadId)
    expect(second.threadReason).toBe("reference")
    expect(third.threadReason).toBe("reference")

    const detail = await service.getThread(fixture.ctx, first.threadId)
    expect(detail.messages).toHaveLength(3)
    expect(detail.thread.messageCount).toBe(3)
  })

  test("two unrelated messages with the same subject do NOT share a thread", async () => {
    const ws = fixture.ctx.workspaceId
    const one = await service.receiveInboundEmail(
      inboundInput(ws, {
        messageId: "<a1@example.com>",
        subject: "Invoice",
        from: { address: "billing@acme.test" },
        to: [{ address: "sales@yourcrm.test" }],
      }),
    )
    const two = await service.receiveInboundEmail(
      inboundInput(ws, {
        messageId: "<b1@other.test>",
        subject: "Invoice",
        from: { address: "accounts@zeta.test" },
        to: [{ address: "sales@yourcrm.test" }],
      }),
    )
    expect(two.threadId).not.toBe(one.threadId)
    expect(two.threadReason).toBe("new")
    expect(fixture.backing.threads.list(ws)).toHaveLength(2)
  })

  test("a header-less reply still threads by subject + participants", async () => {
    const ws = fixture.ctx.workspaceId
    const first = await service.receiveInboundEmail(
      inboundInput(ws, { messageId: "<s1@example.com>", subject: "Renewal" }),
    )
    const second = await service.receiveInboundEmail(
      inboundInput(ws, {
        messageId: "<s2@example.com>",
        subject: "Re: Renewal",
        // Same two addresses, reversed — the participant key ignores order.
        from: { address: "sales@yourcrm.test" },
        to: [{ address: "ada@example.com" }],
      }),
    )
    expect(second.threadId).toBe(first.threadId)
    expect(second.threadReason).toBe("subject")
  })

  test("an inbound html body is sanitised and flattened to text", async () => {
    const result = await service.receiveInboundEmail(
      inboundInput(fixture.ctx.workspaceId, {
        bodyText: null,
        bodyHtml: `<div>Hello <b>there</b><script>steal()</script></div><img src="x" onerror="go()">`,
      }),
    )
    const stored = fixture.backing.messages.get(result.messageId, fixture.ctx.workspaceId)
    expect(stored?.bodyText).toBe("Hello there")
    expect(stored?.bodyHtml).not.toContain("script")
    expect(stored?.bodyHtml).not.toContain("onerror")
    expect(stored?.snippet).toBe("Hello there")
  })

  test("attachment metadata is stored, never bytes", async () => {
    const result = await service.receiveInboundEmail(
      inboundInput(fixture.ctx.workspaceId, {
        attachments: [
          { fileName: "q3.pdf", mimeType: "application/pdf", storageKey: "s3://bucket/q3.pdf" },
        ],
      }),
    )
    const detail = await service.getMessage(fixture.ctx, result.messageId)
    expect(detail.attachments).toHaveLength(1)
    expect(detail.attachments[0]?.fileName).toBe("q3.pdf")
    expect(detail.attachments[0]?.storageKey).toBe("s3://bucket/q3.pdf")
  })

  test("an inbound message with no Message-ID is still stored", async () => {
    const result = await service.receiveInboundEmail(
      inboundInput(fixture.ctx.workspaceId, { messageId: null }),
    )
    expect(result.status).toBe("created")
    const stored = fixture.backing.messages.get(result.messageId, fixture.ctx.workspaceId)
    expect(stored?.messageId).toBeNull()
  })

  test("an inbound reply threads onto an OUTBOUND message we sent", async () => {
    const sent = await fixture.service.sendMessage(fixture.ctx, sendInput())
    const reply = await service.receiveInboundEmail(
      inboundInput(fixture.ctx.workspaceId, {
        messageId: "<reply@example.com>",
        inReplyTo: `<${String(sent.message.messageId)}>`,
        subject: "Re: Q3 Budget",
      }),
    )
    expect(reply.threadId).toBe(sent.message.threadId)
    expect(reply.threadReason).toBe("reference")
  })
})
