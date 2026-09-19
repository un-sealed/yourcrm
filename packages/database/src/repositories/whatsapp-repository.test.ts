import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import type { WhatsAppConversationRow, WhatsAppMessageRow } from "../schema/whatsapp"
import {
  createWhatsAppRepository,
  normalizeWhatsAppPhone,
  WHATSAPP_STATUS_RANK,
} from "./whatsapp-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222"
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333"
const MIGRATION = new URL("../../migrations/0220_whatsapp.sql", import.meta.url)

/** Thenable chain stub: every builder call returns the proxy; each await pops one result. */
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

function makeConversation(
  overrides: Partial<WhatsAppConversationRow> = {},
): WhatsAppConversationRow {
  return {
    id: CONVERSATION_ID,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    connectionId: CONNECTION_ID,
    contactPhone: "+14155552671",
    personId: null,
    companyId: null,
    status: "open",
    lastInboundAt: null,
    lastOutboundAt: null,
    lastMessageAt: null,
    lastMessagePreview: null,
    unreadCount: 0,
    ...overrides,
  }
}

function makeMessage(overrides: Partial<WhatsAppMessageRow> = {}): WhatsAppMessageRow {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    conversationId: CONVERSATION_ID,
    direction: "outbound",
    kind: "text",
    body: "Hello",
    templateId: null,
    templateVariables: null,
    mediaStorageKey: null,
    mediaContentType: null,
    mediaFileName: null,
    mediaSizeBytes: null,
    providerMessageId: "wamid.001",
    status: "sent",
    statusUpdatedAt: new Date("2026-01-01T00:00:00Z"),
    sentAt: new Date("2026-01-01T00:00:00Z"),
    deliveredAt: null,
    readAt: null,
    error: null,
    ...overrides,
  }
}

describe("whatsapp/phone normalisation", () => {
  test("digits-only WhatsApp wa_id (no +) normalises to E.164", () => {
    expect(normalizeWhatsAppPhone("14155552671")).toBe("+14155552671")
  })

  test("already-E.164 numbers pass through", () => {
    expect(normalizeWhatsAppPhone("+14155552671")).toBe("+14155552671")
  })

  test("punctuation, spaces and a leading 00 are stripped/normalised", () => {
    expect(normalizeWhatsAppPhone("+1 (415) 555-2671")).toBe("+14155552671")
    expect(normalizeWhatsAppPhone("0044 20 7946 0958")).toBe("+442079460958")
  })

  test("two different raw spellings of the same number normalise identically", () => {
    expect(normalizeWhatsAppPhone("1-415-555-2671")).toBe(normalizeWhatsAppPhone("+14155552671"))
  })

  test("rejects empty, too-short and non-numeric input", () => {
    expect(() => normalizeWhatsAppPhone("   ")).toThrow(/must not be empty/)
    expect(() => normalizeWhatsAppPhone("12345")).toThrow(/does not normalise/)
    expect(() => normalizeWhatsAppPhone("not-a-phone")).toThrow(/no digits/)
  })
})

describe("whatsapp/status rank", () => {
  test("is monotonic along the happy path", () => {
    expect(WHATSAPP_STATUS_RANK.queued).toBeLessThan(WHATSAPP_STATUS_RANK.sent)
    expect(WHATSAPP_STATUS_RANK.sent).toBeLessThan(WHATSAPP_STATUS_RANK.delivered)
    expect(WHATSAPP_STATUS_RANK.delivered).toBeLessThan(WHATSAPP_STATUS_RANK.read)
  })

  test("failed sits below delivered/read so a late failure cannot regress a delivered message", () => {
    expect(WHATSAPP_STATUS_RANK.failed).toBeLessThan(WHATSAPP_STATUS_RANK.delivered)
    expect(WHATSAPP_STATUS_RANK.failed).toBeLessThan(WHATSAPP_STATUS_RANK.read)
  })
})

describe("whatsapp/conversations", () => {
  test("findOrCreateConversation returns the existing row without inserting", async () => {
    const repo = createWhatsAppRepository()
    const existing = makeConversation()
    const db = mockDb([[existing]])
    const result = await repo.findOrCreateConversation(db, WS, {
      connectionId: CONNECTION_ID,
      contactPhone: "+14155552671",
    })
    expect(result.created).toBe(false)
    expect(result.row).toBe(existing)
  })

  test("findOrCreateConversation normalises the phone and inserts when none exists", async () => {
    const repo = createWhatsAppRepository()
    const inserted = makeConversation()
    const db = mockDb([[], [inserted]])
    const result = await repo.findOrCreateConversation(db, WS, {
      connectionId: CONNECTION_ID,
      contactPhone: "1 (415) 555-2671",
    })
    expect(result.created).toBe(true)
    expect(result.row.contactPhone).toBe("+14155552671")
  })

  test("findOrCreateConversation rejects an invalid phone before touching the db", async () => {
    const repo = createWhatsAppRepository()
    await expect(
      repo.findOrCreateConversation(mockDb(), WS, {
        connectionId: CONNECTION_ID,
        contactPhone: "1",
      }),
    ).rejects.toThrow(/does not normalise/)
  })

  test("updateConversation returns null when the row is missing", async () => {
    const repo = createWhatsAppRepository()
    await expect(
      repo.updateConversation(mockDb([[]]), WS, "missing", { personId: "p1" }),
    ).resolves.toBeNull()
  })

  test("updateConversation rejects an unknown status", async () => {
    const repo = createWhatsAppRepository()
    await expect(
      repo.updateConversation(mockDb(), WS, CONVERSATION_ID, { status: "snoozed" }),
    ).rejects.toThrow(/status must be one of/)
  })
})

describe("whatsapp/messages", () => {
  test("createMessage validates direction before touching the db", async () => {
    const repo = createWhatsAppRepository()
    await expect(
      repo.createMessage(mockDb(), WS, { conversationId: CONVERSATION_ID, direction: "sideways" }),
    ).rejects.toThrow(/direction must be one of/)
  })

  test("createMessage inserts and returns the row", async () => {
    const repo = createWhatsAppRepository()
    const row = makeMessage()
    const result = await repo.createMessage(mockDb([[row]]), WS, {
      conversationId: CONVERSATION_ID,
      direction: "outbound",
      body: "Hello",
    })
    expect(result).toBe(row)
  })

  test("recordInboundMessage is idempotent: an existing providerMessageId short-circuits the insert", async () => {
    const repo = createWhatsAppRepository()
    const existing = makeMessage({ direction: "inbound", providerMessageId: "wamid.dup" })
    const db = mockDb([[existing]])
    const result = await repo.recordInboundMessage(db, WS, {
      conversationId: CONVERSATION_ID,
      direction: "inbound",
      providerMessageId: "wamid.dup",
      body: "Hi again",
    })
    expect(result.created).toBe(false)
    expect(result.row).toBe(existing)
  })

  test("recordInboundMessage inserts a new row when the provider message id is unseen", async () => {
    const repo = createWhatsAppRepository()
    const inserted = makeMessage({ direction: "inbound", providerMessageId: "wamid.new" })
    const db = mockDb([[], [inserted]])
    const result = await repo.recordInboundMessage(db, WS, {
      conversationId: CONVERSATION_ID,
      direction: "inbound",
      providerMessageId: "wamid.new",
      body: "Hi",
    })
    expect(result.created).toBe(true)
    expect(result.row).toBe(inserted)
  })

  describe("applyMessageStatus", () => {
    test("an advancing transition applies and returns the updated row", async () => {
      const repo = createWhatsAppRepository()
      const updated = makeMessage({ status: "delivered" })
      const db = mockDb([[updated]])
      const result = await repo.applyMessageStatus(db, WS, "wamid.001", "delivered")
      expect(result?.applied).toBe(true)
      expect(result?.row.status).toBe("delivered")
    })

    test("a delivered webhook arriving after read does not regress the status", async () => {
      const repo = createWhatsAppRepository()
      const alreadyRead = makeMessage({ status: "read", readAt: new Date("2026-01-01T00:05:00Z") })
      // First call: the rank-guarded UPDATE matches no rows (guard fails).
      // Second call: the repository re-reads the current row to report it.
      const db = mockDb([[], [alreadyRead]])
      const result = await repo.applyMessageStatus(db, WS, "wamid.001", "delivered")
      expect(result?.applied).toBe(false)
      expect(result?.row.status).toBe("read")
    })

    test("replaying the same status twice is a no-op the second time (idempotent)", async () => {
      const repo = createWhatsAppRepository()
      const alreadyDelivered = makeMessage({ status: "delivered" })
      const db = mockDb([[], [alreadyDelivered]])
      const result = await repo.applyMessageStatus(db, WS, "wamid.001", "delivered")
      expect(result?.applied).toBe(false)
      expect(result?.row.status).toBe("delivered")
    })

    test("an unknown providerMessageId resolves to null", async () => {
      const repo = createWhatsAppRepository()
      const db = mockDb([[], []])
      const result = await repo.applyMessageStatus(db, WS, "wamid.missing", "sent")
      expect(result).toBeNull()
    })

    test("rejects an unknown status before touching the db", async () => {
      const repo = createWhatsAppRepository()
      await expect(repo.applyMessageStatus(mockDb(), WS, "wamid.001", "bogus")).rejects.toThrow(
        /status must be one of/,
      )
    })
  })
})

describe("whatsapp/updateMessageById", () => {
  test("attaches a provider message id and flips status to sent", async () => {
    const repo = createWhatsAppRepository()
    const updated = makeMessage({ providerMessageId: "wamid.new", status: "sent" })
    const db = mockDb([[updated]])
    const result = await repo.updateMessageById(db, WS, updated.id, {
      providerMessageId: "wamid.new",
      status: "sent",
    })
    expect(result?.providerMessageId).toBe("wamid.new")
    expect(result?.status).toBe("sent")
  })

  test("records a redacted failure without a provider message id", async () => {
    const repo = createWhatsAppRepository()
    const failed = makeMessage({ providerMessageId: null, status: "failed", error: "[redacted]" })
    const db = mockDb([[failed]])
    const result = await repo.updateMessageById(db, WS, failed.id, {
      status: "failed",
      error: "[redacted]",
    })
    expect(result?.status).toBe("failed")
    expect(result?.error).toBe("[redacted]")
  })

  test("returns null when the row is missing", async () => {
    const repo = createWhatsAppRepository()
    await expect(
      repo.updateMessageById(mockDb([[]]), WS, "missing", { status: "sent" }),
    ).resolves.toBeNull()
  })
})

describe("whatsapp/templates", () => {
  test("createTemplate rejects an empty name before touching the db", async () => {
    const repo = createWhatsAppRepository()
    await expect(
      repo.createTemplate(mockDb(), WS, {
        connectionId: CONNECTION_ID,
        name: "  ",
        bodyText: "Hi",
      }),
    ).rejects.toThrow(/name must not be empty/)
  })

  test("createTemplate defaults language and status", async () => {
    const repo = createWhatsAppRepository()
    const row = await repo.createTemplate(
      mockDb([
        [
          {
            id: "tpl_1",
            workspaceId: WS,
            connectionId: CONNECTION_ID,
            name: "order_update",
            language: "en_US",
            category: null,
            status: "approved",
            bodyText: "Your order {{1}} shipped",
            variableCount: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
            createdBy: null,
            updatedBy: null,
            deletedAt: null,
          },
        ],
      ]),
      WS,
      {
        connectionId: CONNECTION_ID,
        name: "order_update",
        bodyText: "Your order {{1}} shipped",
        variableCount: 1,
      },
    )
    expect(row.language).toBe("en_US")
    expect(row.status).toBe("approved")
  })
})

describe("whatsapp/migration", () => {
  test("0220 creates conversations, templates and messages with the agreed indexes", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS whatsapp_conversations")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS whatsapp_templates")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS whatsapp_messages")
    expect(sql).toContain("whatsapp_conversations_connection_phone_uidx")
    expect(sql).toContain("whatsapp_messages_provider_message_uidx")
    expect(sql).toContain("REFERENCES whatsapp_conversations (id) ON DELETE CASCADE")
    expect(sql).toContain("REFERENCES whatsapp_templates (id) ON DELETE SET NULL")
  })

  test("connection_id, person_id and company_id stay FK-free", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const block = sql.slice(
      sql.indexOf("CREATE TABLE IF NOT EXISTS whatsapp_conversations"),
      sql.indexOf("CREATE TABLE IF NOT EXISTS whatsapp_templates"),
    )
    expect(block).toContain("connection_id UUID NOT NULL")
    expect(block).toContain("person_id UUID")
    expect(block).toContain("company_id UUID")
    expect(block).not.toContain("REFERENCES")
  })
})
