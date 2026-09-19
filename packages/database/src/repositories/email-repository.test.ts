import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import {
  emailAttachments,
  emailMessages,
  emailParticipants,
  emailThreads,
  isEmailMessageDirection,
  isEmailMessageStatus,
  isEmailParticipantRole,
  isEmailThreadStatus,
  type EmailMessage,
  type EmailThread,
} from "../schema/email"
import {
  createEmailRepository,
  validateEmailHeaderId,
  validateEmailParticipantAddress,
} from "./email-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const THREAD_ID = "22222222-2222-4222-8222-222222222222"
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333"
const MIGRATION = new URL("../../migrations/0210_email.sql", import.meta.url)

/** Thenable chain stub: every query builder call returns the proxy; each await pops one result. */
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

function makeThread(overrides: Partial<EmailThread> = {}): EmailThread {
  return {
    id: THREAD_ID,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    ownerId: null,
    subject: "Q3 Budget",
    normalizedSubject: "q3 budget",
    participantKey: "a".repeat(64),
    status: "open",
    messageCount: 0,
    lastMessageAt: null,
    personId: null,
    companyId: null,
    dealId: null,
    ...overrides,
  }
}

function makeMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: MESSAGE_ID,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    threadId: THREAD_ID,
    direction: "inbound",
    status: "received",
    messageId: "m1@example.com",
    inReplyTo: null,
    referenceIds: [],
    subject: "Q3 Budget",
    fromAddress: "ada@example.com",
    fromName: "Ada",
    bodyText: "hello",
    bodyHtml: null,
    snippet: "hello",
    hasAttachments: false,
    connectionId: null,
    providerId: "console-email",
    providerMessageId: null,
    sentAt: null,
    receivedAt: new Date("2026-01-01T00:00:00Z"),
    lastError: null,
    lastErrorAt: null,
    personId: null,
    companyId: null,
    dealId: null,
    ...overrides,
  }
}

describe("email/schema", () => {
  test("every table exposes the BaseRecord column contract", () => {
    for (const table of [emailThreads, emailMessages, emailParticipants, emailAttachments]) {
      const cols = table as unknown as Record<string, unknown>
      for (const col of ["id", "workspaceId", "createdAt", "updatedAt", "deletedAt"]) {
        expect(cols[col], col).toBeDefined()
      }
    }
  })

  test("threads carry the two threading fallback keys", () => {
    const cols = emailThreads as unknown as Record<string, unknown>
    expect(cols.normalizedSubject).toBeDefined()
    expect(cols.participantKey).toBeDefined()
    expect(cols.lastMessageAt).toBeDefined()
    expect(cols.messageCount).toBeDefined()
  })

  test("messages carry the RFC 5322 threading headers and CRM links", () => {
    const cols = emailMessages as unknown as Record<string, unknown>
    for (const col of ["messageId", "inReplyTo", "referenceIds", "threadId"]) {
      expect(cols[col], col).toBeDefined()
    }
    for (const col of ["personId", "companyId", "dealId", "connectionId"]) {
      expect(cols[col], col).toBeDefined()
    }
  })

  test("attachments hold metadata and a storage key, never bytes", () => {
    const cols = emailAttachments as unknown as Record<string, unknown>
    expect(cols.storageKey).toBeDefined()
    expect(cols.fileName).toBeDefined()
    expect(cols.sizeBytes).toBeDefined()
    for (const col of ["data", "bytes", "content", "payload", "body"]) {
      expect(cols[col], col).toBeUndefined()
    }
  })

  test("enum guards accept only the documented values", () => {
    expect(isEmailMessageDirection("inbound")).toBe(true)
    expect(isEmailMessageDirection("sideways")).toBe(false)
    expect(isEmailMessageStatus("bounced")).toBe(true)
    expect(isEmailMessageStatus("maybe")).toBe(false)
    expect(isEmailParticipantRole("reply_to")).toBe(true)
    expect(isEmailParticipantRole("sender")).toBe(false)
    expect(isEmailThreadStatus("archived")).toBe(true)
    expect(isEmailThreadStatus("deleted")).toBe(false)
  })
})

describe("email/validation", () => {
  test("participant addresses lowercase and validate shape", () => {
    expect(validateEmailParticipantAddress(" Ada@Example.COM ")).toBe("ada@example.com")
    expect(() => validateEmailParticipantAddress("not-an-email")).toThrow()
    expect(() => validateEmailParticipantAddress(`${"x".repeat(320)}@example.com`)).toThrow()
  })

  test("header ids are length-checked only (the domain layer normalises)", () => {
    expect(validateEmailHeaderId("m1@example.com", "messageId")).toBe("m1@example.com")
    expect(() => validateEmailHeaderId("", "messageId")).toThrow()
    expect(() => validateEmailHeaderId("x".repeat(999), "messageId")).toThrow()
  })
})

describe("email/repository", () => {
  test("createThread returns the inserted row", async () => {
    const repo = createEmailRepository()
    const row = makeThread()
    const result = await repo.createThread(mockDb([[row]]), WS, {
      normalizedSubject: "q3 budget",
      participantKey: "a".repeat(64),
    })
    expect(result).toBe(row)
  })

  test("createThread surfaces an empty insert as an error", async () => {
    const repo = createEmailRepository()
    await expect(
      repo.createThread(mockDb([[]]), WS, { normalizedSubject: "x", participantKey: "y" }),
    ).rejects.toThrow()
  })

  test("createThread rejects an unknown status before touching the db", async () => {
    const repo = createEmailRepository()
    await expect(
      repo.createThread(mockDb(), WS, {
        normalizedSubject: "x",
        participantKey: "y",
        status: "spam",
      }),
    ).rejects.toThrow(/status/)
  })

  test("createMessage inserts the message then its participants and attachments", async () => {
    const repo = createEmailRepository()
    const message = makeMessage()
    const participant = { id: "p1", emailMessageId: MESSAGE_ID }
    const attachment = { id: "a1", emailMessageId: MESSAGE_ID }
    const result = await repo.createMessage(mockDb([[message], [participant], [attachment]]), WS, {
      threadId: THREAD_ID,
      direction: "inbound",
      participants: [{ role: "from", address: "Ada@Example.com" }],
      attachments: [{ fileName: "q3.pdf", storageKey: "s3://bucket/q3.pdf" }],
    })
    expect(result.message).toBe(message)
    expect(result.participants).toHaveLength(1)
    expect(result.attachments).toHaveLength(1)
  })

  test("createMessage rejects an unknown direction before touching the db", async () => {
    const repo = createEmailRepository()
    await expect(
      repo.createMessage(mockDb(), WS, { threadId: THREAD_ID, direction: "sideways" }),
    ).rejects.toThrow(/direction/)
  })

  test("createMessage rejects an invalid participant address", async () => {
    const repo = createEmailRepository()
    await expect(
      repo.createMessage(mockDb([[makeMessage()]]), WS, {
        threadId: THREAD_ID,
        direction: "inbound",
        participants: [{ role: "to", address: "nope" }],
      }),
    ).rejects.toThrow(/address/)
  })

  test("findThreadIdsByMessageIds short-circuits on an empty id list", async () => {
    const repo = createEmailRepository()
    await expect(repo.findThreadIdsByMessageIds(mockDb(), WS, [])).resolves.toEqual([])
  })

  test("findThreadIdsByMessageIds drops rows with a null message id", async () => {
    const repo = createEmailRepository()
    const rows = [
      { messageId: "m1@example.com", threadId: THREAD_ID },
      { messageId: null, threadId: "other" },
    ]
    await expect(
      repo.findThreadIdsByMessageIds(mockDb([rows]), WS, ["m1@example.com"]),
    ).resolves.toEqual([{ messageId: "m1@example.com", threadId: THREAD_ID }])
  })

  test("findThreadByMatch refuses to match on an empty key (no mega-thread)", async () => {
    const repo = createEmailRepository()
    await expect(
      repo.findThreadByMatch(mockDb([[makeThread()]]), WS, {
        normalizedSubject: "",
        participantKey: "a".repeat(64),
      }),
    ).resolves.toBeNull()
    await expect(
      repo.findThreadByMatch(mockDb([[makeThread()]]), WS, {
        normalizedSubject: "q3 budget",
        participantKey: "",
      }),
    ).resolves.toBeNull()
  })

  test("findThreadByMatch returns the thread when both keys are present", async () => {
    const repo = createEmailRepository()
    const thread = makeThread()
    await expect(
      repo.findThreadByMatch(mockDb([[thread]]), WS, {
        normalizedSubject: "q3 budget",
        participantKey: "a".repeat(64),
        activeSince: new Date("2026-01-01T00:00:00Z"),
      }),
    ).resolves.toBe(thread)
  })

  test("searchThreads returns the cursor pagination envelope", async () => {
    const repo = createEmailRepository()
    const rows = [
      makeThread({ id: "id-1" }),
      makeThread({ id: "id-2" }),
      makeThread({ id: "id-3" }),
    ]
    const result = await repo.searchThreads(mockDb([rows]), { workspaceId: WS, limit: 2 })
    expect(result.data).toHaveLength(2)
    expect(result.pagination).toEqual({ nextCursor: "id-2", limit: 2 })
  })

  test("searchThreads rejects an unknown status filter", async () => {
    const repo = createEmailRepository()
    await expect(repo.searchThreads(mockDb(), { workspaceId: WS, status: "spam" })).rejects.toThrow(
      /status/,
    )
  })

  test("updateMessage returns null when the row is missing", async () => {
    const repo = createEmailRepository()
    await expect(
      repo.updateMessage(mockDb([[]]), WS, "missing", { status: "sent" }),
    ).resolves.toBeNull()
  })

  test("updateMessage rejects an unknown status", async () => {
    const repo = createEmailRepository()
    await expect(repo.updateMessage(mockDb(), WS, MESSAGE_ID, { status: "maybe" })).rejects.toThrow(
      /status/,
    )
  })

  test("findThreadWithMessages returns null when the thread is missing", async () => {
    const repo = createEmailRepository()
    await expect(repo.findThreadWithMessages(mockDb([[]]), WS, "missing")).resolves.toBeNull()
  })

  test("findMessageByMessageId returns null when nothing matches", async () => {
    const repo = createEmailRepository()
    await expect(
      repo.findMessageByMessageId(mockDb([[]]), WS, "nope@example.com"),
    ).resolves.toBeNull()
  })
})

describe("email/migration", () => {
  test("0210 creates all four tables", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    for (const table of [
      "email_threads",
      "email_messages",
      "email_participants",
      "email_attachments",
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
  })

  test("the threading columns and indexes exist", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("message_id VARCHAR(998)")
    expect(sql).toContain("in_reply_to VARCHAR(998)")
    // `references` is a reserved word — the column is reference_ids.
    expect(sql).toContain("reference_ids JSONB")
    expect(sql).not.toContain("  references ")
    expect(sql).toContain("normalized_subject TEXT")
    expect(sql).toContain("participant_key VARCHAR(64)")
    expect(sql).toContain("email_threads_match_idx")
    expect(sql).toContain("ON email_threads (workspace_id, normalized_subject, participant_key)")
  })

  test("the Message-ID uniqueness guard is workspace-scoped and unfiltered by deleted_at", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const line = sql
      .split("CREATE UNIQUE INDEX IF NOT EXISTS email_messages_message_id_uidx")[1]
      ?.split(";")[0]
    expect(line).toContain("(workspace_id, message_id)")
    expect(line).toContain("WHERE message_id IS NOT NULL")
    expect(line).not.toContain("deleted_at")
  })

  test("only this module's own tables are foreign keys", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("REFERENCES email_threads (id) ON DELETE CASCADE")
    expect(sql).toContain("REFERENCES email_messages (id) ON DELETE CASCADE")
    for (const table of ["people", "companies", "deals", "integration_connections", "users"]) {
      expect(sql, table).not.toContain(`REFERENCES ${table}`)
    }
  })

  test("cross-module links stay plain uuid columns", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const block = sql.slice(
      sql.indexOf("CREATE TABLE IF NOT EXISTS email_messages"),
      sql.indexOf("CREATE TABLE IF NOT EXISTS email_participants"),
    )
    for (const column of [
      "person_id UUID",
      "company_id UUID",
      "deal_id UUID",
      "connection_id UUID",
    ])
      expect(block, column).toContain(column)
  })

  test("attachments store a storage key, never bytes", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const block = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS email_attachments"))
    expect(block).toContain("storage_key TEXT")
    expect(block).not.toContain("BYTEA")
  })
})
