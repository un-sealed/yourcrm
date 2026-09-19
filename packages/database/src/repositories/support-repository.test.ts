import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import { ticketComments, tickets, type SupportTicketRow } from "../schema/support"
import {
  createSupportTicketRepository,
  normalizeCommentBody,
  normalizeTicketSubject,
} from "./support-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const TICKET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const MIGRATION = new URL("../../migrations/0250_support.sql", import.meta.url)

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

function makeTicket(overrides: Partial<SupportTicketRow> = {}): SupportTicketRow {
  return {
    id: TICKET_ID,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    subject: "Cannot log in",
    description: null,
    status: "new",
    priority: "normal",
    requesterId: "22222222-2222-4222-8222-222222222222",
    assigneeId: null,
    channel: "manual",
    firstResponseDueAt: null,
    firstResponseAt: null,
    resolutionDueAt: null,
    resolvedAt: null,
    closedAt: null,
    ...overrides,
  }
}

describe("support/schema", () => {
  test("tickets expose the BaseRecord column contract plus support fields", () => {
    const cols = tickets as unknown as Record<string, unknown>
    for (const col of ["id", "workspaceId", "createdAt", "updatedAt", "deletedAt"]) {
      expect(cols[col], col).toBeDefined()
    }
    expect(cols.subject).toBeDefined()
    expect(cols.status).toBeDefined()
    expect(cols.priority).toBeDefined()
    expect(cols.requesterId).toBeDefined()
    expect(cols.assigneeId).toBeDefined()
    expect(cols.channel).toBeDefined()
    expect(cols.firstResponseDueAt).toBeDefined()
    expect(cols.firstResponseAt).toBeDefined()
    expect(cols.resolutionDueAt).toBeDefined()
    expect(cols.resolvedAt).toBeDefined()
    expect(cols.closedAt).toBeDefined()
  })

  test("ticket_comments carry a ticket FK, plain author ref, is_internal, and workspace scoping", () => {
    const cols = ticketComments as unknown as Record<string, unknown>
    expect(cols.ticketId).toBeDefined()
    expect(cols.authorId).toBeDefined()
    expect(cols.body).toBeDefined()
    expect(cols.isInternal).toBeDefined()
    expect(cols.workspaceId).toBeDefined()
  })
})

describe("support/validation", () => {
  test("subjects trim and collapse whitespace", () => {
    expect(normalizeTicketSubject("  Cannot   log in ")).toBe("Cannot log in")
  })

  test("subjects reject empty and overlong values", () => {
    expect(() => normalizeTicketSubject("   ")).toThrow()
    expect(() => normalizeTicketSubject("x".repeat(256))).toThrow()
  })

  test("comment bodies trim and reject empty/overlong values", () => {
    expect(normalizeCommentBody("  hello  ")).toBe("hello")
    expect(() => normalizeCommentBody("   ")).toThrow()
    expect(() => normalizeCommentBody("x".repeat(10001))).toThrow()
  })
})

describe("support/repository", () => {
  test("create returns the inserted row", async () => {
    const repo = createSupportTicketRepository()
    const row = makeTicket()
    const result = await repo.create(mockDb([[row]]), WS, {
      subject: "Cannot log in",
      requesterId: row.requesterId,
    })
    expect(result).toBe(row)
  })

  test("create rejects empty subjects before touching the db", async () => {
    const repo = createSupportTicketRepository()
    await expect(
      repo.create(mockDb(), WS, { subject: "  ", requesterId: "person_1" }),
    ).rejects.toThrow()
  })

  test("create rejects an empty requesterId", async () => {
    const repo = createSupportTicketRepository()
    await expect(repo.create(mockDb(), WS, { subject: "Hi", requesterId: " " })).rejects.toThrow()
  })

  test("create surfaces empty insert results as errors", async () => {
    const repo = createSupportTicketRepository()
    await expect(
      repo.create(mockDb([[]]), WS, { subject: "Hi", requesterId: "person_1" }),
    ).rejects.toThrow()
  })

  test("create rejects unknown status/priority/channel values", async () => {
    const repo = createSupportTicketRepository()
    await expect(
      repo.create(mockDb(), WS, { subject: "Hi", requesterId: "p1", status: "archived" }),
    ).rejects.toThrow(/status/)
    await expect(
      repo.create(mockDb(), WS, { subject: "Hi", requesterId: "p1", priority: "critical" }),
    ).rejects.toThrow(/priority/)
    await expect(
      repo.create(mockDb(), WS, { subject: "Hi", requesterId: "p1", channel: "fax" }),
    ).rejects.toThrow(/channel/)
  })

  test("search returns the cursor pagination envelope", async () => {
    const repo = createSupportTicketRepository()
    const rows = [
      makeTicket({ id: "id-1" }),
      makeTicket({ id: "id-2" }),
      makeTicket({ id: "id-3" }),
    ]
    const result = await repo.search(mockDb([rows]), { workspaceId: WS, limit: 2, query: "log in" })
    expect(result.data).toHaveLength(2)
    expect(result.pagination).toEqual({ nextCursor: "id-2", limit: 2 })
  })

  test("search rejects an unknown status filter", async () => {
    const repo = createSupportTicketRepository()
    await expect(
      repo.search(mockDb([[]]), { workspaceId: WS, status: "archived" }),
    ).rejects.toThrow(/status/)
  })

  test("update returns null when the row is missing", async () => {
    const repo = createSupportTicketRepository()
    await expect(
      repo.update(mockDb([[]]), WS, "missing", { subject: "New subject" }),
    ).resolves.toBeNull()
  })

  test("findWithComments returns null when the ticket is missing", async () => {
    const repo = createSupportTicketRepository()
    await expect(repo.findWithComments(mockDb([[]]), WS, "missing")).resolves.toBeNull()
  })

  test("findWithComments returns the ticket plus its comments", async () => {
    const repo = createSupportTicketRepository()
    const ticket = makeTicket()
    const comment = {
      id: "comment-1",
      workspaceId: WS,
      ticketId: TICKET_ID,
      authorId: "user-1",
      body: "Looking into it",
      isInternal: false,
      createdAt: new Date("2026-01-01T00:05:00Z"),
      updatedAt: new Date("2026-01-01T00:05:00Z"),
      createdBy: "user-1",
      updatedBy: "user-1",
      deletedAt: null,
    }
    const result = await repo.findWithComments(mockDb([[ticket], [comment]]), WS, TICKET_ID)
    expect(result?.ticket).toBe(ticket)
    expect(result?.comments).toEqual([comment])
  })

  test("addComment returns the inserted comment", async () => {
    const repo = createSupportTicketRepository()
    const comment = {
      id: "comment-1",
      workspaceId: WS,
      ticketId: TICKET_ID,
      authorId: "user-1",
      body: "Hello",
      isInternal: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: "user-1",
      updatedBy: "user-1",
      deletedAt: null,
    }
    const result = await repo.addComment(
      mockDb([[comment]]),
      WS,
      TICKET_ID,
      { body: "Hello" },
      "user-1",
    )
    expect(result).toBe(comment)
  })

  test("addComment rejects an empty body before touching the db", async () => {
    const repo = createSupportTicketRepository()
    await expect(
      repo.addComment(mockDb(), WS, TICKET_ID, { body: "  " }, "user-1"),
    ).rejects.toThrow()
  })
})

describe("support/migration", () => {
  test("0250 creates tickets plus ticket_comments with the agreed indexes", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS tickets")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS ticket_comments")
    expect(sql).toContain("tickets_requester_idx")
    expect(sql).toContain("ON tickets (requester_id)")
    expect(sql).toContain("ticket_comments_ticket_idx")
    expect(sql).toContain("REFERENCES tickets (id) ON DELETE CASCADE")
  })

  test("cross-module references (requester, assignee, author) stay FK-free", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const ticketsBlock = sql.slice(
      sql.indexOf("CREATE TABLE IF NOT EXISTS tickets"),
      sql.indexOf("CREATE TABLE IF NOT EXISTS ticket_comments"),
    )
    expect(ticketsBlock).toContain("requester_id UUID NOT NULL")
    expect(ticketsBlock).toContain("assignee_id UUID")
    expect(ticketsBlock).not.toContain("REFERENCES people")
    expect(ticketsBlock).not.toContain("REFERENCES users")

    const commentsBlock = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS ticket_comments"))
    expect(commentsBlock).toContain("author_id UUID NOT NULL")
    expect(commentsBlock).not.toContain("REFERENCES users")
  })

  test("status/priority/channel are constrained by explicit CHECK lists", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CHECK (status IN ('new', 'open', 'pending', 'resolved', 'closed'))")
    expect(sql).toContain("CHECK (priority IN ('low', 'normal', 'high', 'urgent'))")
    expect(sql).toContain(
      "CHECK (channel IN ('email', 'chat', 'whatsapp', 'phone', 'web', 'api', 'manual'))",
    )
  })
})
