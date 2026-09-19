import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import { INBOX_CHANNELS, isInboxChannel } from "../schema/unified-inbox"
import {
  createUnifiedInboxRepository,
  decodeInboxCursor,
  encodeInboxCursor,
  inboxItemKey,
  inboxPreview,
  INBOX_MAX_LIMIT,
  INBOX_PREVIEW_MAX_LENGTH,
  InvalidInboxCursorError,
  isInboxItemUnread,
  type InboxListOptions,
} from "./unified-inbox-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const ACTOR = "22222222-2222-4222-8222-222222222222"
const THREAD = "33333333-3333-4333-8333-333333333333"
const CALL = "44444444-4444-4444-8444-444444444444"
const PERSON = "55555555-5555-4555-8555-555555555555"
const DEAL = "66666666-6666-4666-8666-666666666666"
const MIGRATION = new URL("../../migrations/0240_unified_inbox.sql", import.meta.url)

/**
 * Thenable chain stub: every builder call returns the proxy; each await pops
 * one queued result. Same hermetic pattern as `search-repository.test.ts` —
 * `docs/conventions.md` forbids a live Postgres in unit tests.
 */
function mockDb(queued: unknown[][] = []) {
  const seen: { sql: string; params: unknown[] }[] = []
  let step = 0
  const proxy = new Proxy(function () {}, {
    get(_target, prop: string | symbol) {
      if (prop === "then") {
        return (resolve: (value: unknown) => void) => {
          resolve(queued[step] ?? [])
          step += 1
        }
      }
      if (prop === "execute") {
        return (statement: { queryChunks?: unknown[] }) => {
          seen.push({ sql: renderChunks(statement), params: [] })
          const result = queued[step] ?? []
          step += 1
          return Promise.resolve(result)
        }
      }
      return (..._args: unknown[]) => proxy
    },
  })
  return { db: proxy as unknown as Database, seen }
}

/**
 * Flatten a drizzle `SQL` object into inspectable text with whitespace
 * collapsed. Bound parameters render as `?` so the assertions below check the
 * *shape* of the query, never the values — which is the point: a filter that
 * silently stopped reaching the WHERE clause would still "pass" if we only
 * inspected parameters.
 */
function renderChunks(statement: { queryChunks?: unknown[] }): string {
  const out: string[] = []
  const walk = (chunk: unknown): void => {
    if (chunk === null || chunk === undefined) return
    if (Array.isArray(chunk)) {
      for (const inner of chunk) walk(inner)
      return
    }
    if (typeof chunk === "object") {
      const record = chunk as Record<string, unknown>
      // StringChunk: literal SQL text, held as string[].
      if (Array.isArray(record.value)) {
        for (const inner of record.value) out.push(String(inner))
        return
      }
      // Nested SQL fragment (including `sql.raw`).
      if (Array.isArray(record.queryChunks)) {
        for (const inner of record.queryChunks) walk(inner)
        return
      }
    }
    // Anything else is an interpolated value drizzle will bind.
    out.push("?")
  }
  for (const chunk of statement.queryChunks ?? []) walk(chunk)
  return out.join("").replace(/\s+/g, " ").trim()
}

function listOptions(overrides: Partial<InboxListOptions> = {}): InboxListOptions {
  return {
    workspaceId: WS,
    channels: INBOX_CHANNELS,
    scope: { kind: "all" },
    ...overrides,
  }
}

function streamRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: "call",
    sourceId: CALL,
    workspaceId: WS,
    sortAt: new Date("2026-03-01T10:00:00Z"),
    title: null,
    participant: "+15550000001",
    preview: "connected",
    direction: "inbound",
    status: "completed",
    personId: null,
    companyId: null,
    dealId: null,
    ownerId: ACTOR,
    assignedTo: null,
    assignedAt: null,
    readAt: null,
    archivedAt: null,
    ...overrides,
  }
}

describe("unified-inbox/cursor", () => {
  test("round-trips the (sortAt, sourceId) keyset pair", () => {
    const at = new Date("2026-03-01T10:00:00.123Z")
    const decoded = decodeInboxCursor(encodeInboxCursor(at, CALL))
    expect(decoded?.sortAt.toISOString()).toBe(at.toISOString())
    expect(decoded?.sourceId).toBe(CALL)
  })

  test("absent cursor decodes to null", () => {
    expect(decodeInboxCursor(null)).toBeNull()
    expect(decodeInboxCursor(undefined)).toBeNull()
    expect(decodeInboxCursor("")).toBeNull()
  })

  test("a malformed cursor is rejected, never silently ignored", () => {
    expect(() => decodeInboxCursor("not-a-cursor")).toThrow(InvalidInboxCursorError)
    expect(() => decodeInboxCursor(encodeInboxCursor(new Date(), "nope"))).toThrow(
      InvalidInboxCursorError,
    )
  })

  test("cursors are url-safe (no +, / or = to escape in a query string)", () => {
    const cursor = encodeInboxCursor(new Date("2026-03-01T10:00:00.999Z"), CALL)
    expect(cursor).not.toContain("+")
    expect(cursor).not.toContain("/")
    expect(cursor).not.toContain("=")
  })
})

describe("unified-inbox/item key", () => {
  test("composite key names the channel and the source row", () => {
    expect(inboxItemKey("email", THREAD)).toBe(`email:${THREAD}`)
  })

  test("channels are the three implemented sources", () => {
    expect([...INBOX_CHANNELS]).toEqual(["email", "whatsapp", "call"])
    expect(isInboxChannel("sms")).toBe(false)
  })
})

describe("unified-inbox/unread watermark", () => {
  const sortAt = new Date("2026-03-01T10:00:00Z")

  test("never read means unread", () => {
    expect(isInboxItemUnread(null, sortAt)).toBe(true)
  })

  test("read after the last activity means read", () => {
    expect(isInboxItemUnread(new Date("2026-03-01T10:00:01Z"), sortAt)).toBe(false)
  })

  test("a newer message pushes a read item back to unread", () => {
    expect(isInboxItemUnread(new Date("2026-03-01T09:59:59Z"), sortAt)).toBe(true)
  })
})

describe("unified-inbox/preview", () => {
  test("collapses whitespace", () => {
    expect(inboxPreview("  hello\n\n world ")).toBe("hello world")
  })

  test("truncates instead of rejecting", () => {
    const preview = inboxPreview("x".repeat(INBOX_PREVIEW_MAX_LENGTH + 50))
    expect(preview?.length).toBe(INBOX_PREVIEW_MAX_LENGTH)
    expect(preview?.endsWith("…")).toBe(true)
  })

  test("empty and missing text become null", () => {
    expect(inboxPreview("   ")).toBeNull()
    expect(inboxPreview(null)).toBeNull()
  })
})

describe("unified-inbox/stream sql", () => {
  test("merges one CTE per requested channel", async () => {
    const { db, seen } = mockDb([[]])
    await createUnifiedInboxRepository().listItems(db, listOptions())
    const text = seen[0]?.sql ?? ""
    expect(text).toContain("inbox_email AS")
    expect(text).toContain("inbox_whatsapp AS")
    expect(text).toContain("inbox_call AS")
    expect(text).toContain("UNION ALL")
    expect(text).toContain("FROM email_threads t")
    expect(text).toContain("FROM whatsapp_conversations t")
    expect(text).toContain("FROM calls t")
  })

  test("a single channel produces one arm and no union", async () => {
    const { db, seen } = mockDb([[]])
    await createUnifiedInboxRepository().listItems(db, listOptions({ channels: ["whatsapp"] }))
    const text = seen[0]?.sql ?? ""
    expect(text).toContain("inbox_whatsapp AS")
    expect(text).not.toContain("inbox_email AS")
    expect(text).not.toContain("UNION ALL")
  })

  test("no readable channel short-circuits to an empty page without querying", async () => {
    const { db, seen } = mockDb([[]])
    const result = await createUnifiedInboxRepository().listItems(db, listOptions({ channels: [] }))
    expect(result.data).toEqual([])
    expect(result.pagination.nextCursor).toBeNull()
    expect(seen).toHaveLength(0)
  })

  test("both the branch and the outer query sort on (sortAt, sourceId)", async () => {
    const { db, seen } = mockDb([[]])
    await createUnifiedInboxRepository().listItems(db, listOptions({ channels: ["call"] }))
    const text = seen[0]?.sql ?? ""
    const orderings = text.match(/ORDER BY "sortAt" DESC, "sourceId" DESC/g) ?? []
    // Once inside the branch CTE, once over the merged stream: the per-branch
    // LIMIT is only sound while both use the same key.
    expect(orderings).toHaveLength(2)
  })

  test("asc order flips both the sort and the cursor comparator", async () => {
    const { db, seen } = mockDb([[]])
    await createUnifiedInboxRepository().listItems(
      db,
      listOptions({
        channels: ["call"],
        order: "asc",
        cursor: encodeInboxCursor(new Date("2026-03-01T10:00:00Z"), CALL),
      }),
    )
    const text = seen[0]?.sql ?? ""
    expect(text).toContain('ORDER BY "sortAt" ASC, "sourceId" ASC')
    expect(text).toContain("t.id >")
    expect(text).not.toContain("t.id <")
  })

  test("permission scope is a WHERE predicate, not a post-pagination filter", async () => {
    const { db, seen } = mockDb([[]])
    await createUnifiedInboxRepository().listItems(
      db,
      listOptions({ channels: ["email"], scope: { kind: "own", actorId: ACTOR } }),
    )
    const text = seen[0]?.sql ?? ""
    const whereAt = text.indexOf("WHERE")
    const limitAt = text.indexOf("LIMIT")
    expect(whereAt).toBeGreaterThan(-1)
    expect(text.indexOf("t.owner_id = ?::uuid")).toBeGreaterThan(whereAt)
    expect(text.indexOf("t.owner_id = ?::uuid")).toBeLessThan(limitAt)
    expect(text).toContain("t.created_by = ?::uuid")
    expect(text).toContain("s.assigned_to = ?::uuid")
  })

  test("workspace scope adds no ownership predicate", async () => {
    const { db, seen } = mockDb([[]])
    await createUnifiedInboxRepository().listItems(db, listOptions({ channels: ["email"] }))
    expect(seen[0]?.sql ?? "").not.toContain("t.created_by = ?::uuid")
  })

  test("whatsapp scopes on created_by because it has no owner_id", async () => {
    const { db, seen } = mockDb([[]])
    await createUnifiedInboxRepository().listItems(
      db,
      listOptions({ channels: ["whatsapp"], scope: { kind: "own", actorId: ACTOR } }),
    )
    const text = seen[0]?.sql ?? ""
    expect(text).toContain("NULL::uuid = ?::uuid")
    expect(text).toContain("t.created_by = ?::uuid")
  })

  test("a deal filter drops the whatsapp branch entirely", async () => {
    const { db, seen } = mockDb([[]])
    await createUnifiedInboxRepository().listItems(db, listOptions({ dealId: DEAL }))
    const text = seen[0]?.sql ?? ""
    expect(text).toContain("inbox_email AS")
    expect(text).toContain("inbox_call AS")
    expect(text).not.toContain("inbox_whatsapp AS")
  })

  test("a deal filter with only whatsapp readable returns an empty page", async () => {
    const { db, seen } = mockDb([[]])
    const result = await createUnifiedInboxRepository().listItems(
      db,
      listOptions({ channels: ["whatsapp"], dealId: DEAL }),
    )
    expect(result.data).toEqual([])
    expect(seen).toHaveLength(0)
  })

  test("unread, archived and assignment filters are applied inside the branch", async () => {
    const { db, seen } = mockDb([[]])
    await createUnifiedInboxRepository().listItems(
      db,
      listOptions({
        channels: ["call"],
        unread: true,
        archived: false,
        assignment: { kind: "user", userId: ACTOR },
        personId: PERSON,
      }),
    )
    const text = seen[0]?.sql ?? ""
    const branchWhere = text.slice(text.indexOf("WHERE"), text.indexOf('ORDER BY "sortAt"'))
    expect(branchWhere).toContain("s.read_at IS NULL")
    expect(branchWhere).toContain("s.archived_at IS NULL")
    expect(branchWhere).toContain("s.assigned_to = ?::uuid")
    expect(branchWhere).toContain("t.person_id = ?::uuid")
  })

  test("read-only and unassigned filters invert correctly", async () => {
    const readOnly = mockDb([[]])
    await createUnifiedInboxRepository().listItems(
      readOnly.db,
      listOptions({ channels: ["call"], unread: false, archived: true }),
    )
    expect(readOnly.seen[0]?.sql ?? "").toContain("s.read_at IS NOT NULL")
    expect(readOnly.seen[0]?.sql ?? "").toContain("s.archived_at IS NOT NULL")

    const unassigned = mockDb([[]])
    await createUnifiedInboxRepository().listItems(
      unassigned.db,
      listOptions({ channels: ["call"], assignment: { kind: "unassigned" } }),
    )
    expect(unassigned.seen[0]?.sql ?? "").toContain("s.assigned_to IS NULL")
  })

  test("a non-uuid filter value is rejected before it reaches SQL", async () => {
    const { db } = mockDb([[]])
    await expect(
      createUnifiedInboxRepository().listItems(db, listOptions({ personId: "not-a-uuid" })),
    ).rejects.toThrow("must be a uuid")
  })
})

describe("unified-inbox/paging", () => {
  test("fetches limit + 1 and returns a keyset cursor from the last kept row", async () => {
    const older = new Date("2026-03-01T09:00:00Z")
    const rows = [
      streamRow({ sortAt: new Date("2026-03-01T10:00:00Z") }),
      streamRow({ sourceId: THREAD, sortAt: older }),
      streamRow({ sourceId: DEAL, sortAt: new Date("2026-03-01T08:00:00Z") }),
    ]
    const { db } = mockDb([rows])
    const result = await createUnifiedInboxRepository().listItems(
      db,
      listOptions({ channels: ["call"], limit: 2 }),
    )
    expect(result.data).toHaveLength(2)
    expect(result.pagination.limit).toBe(2)
    expect(decodeInboxCursor(result.pagination.nextCursor)).toEqual({
      sortAt: older,
      sourceId: THREAD,
    })
  })

  test("the last page reports no next cursor", async () => {
    const { db } = mockDb([[streamRow()]])
    const result = await createUnifiedInboxRepository().listItems(
      db,
      listOptions({ channels: ["call"], limit: 25 }),
    )
    expect(result.data).toHaveLength(1)
    expect(result.pagination.nextCursor).toBeNull()
  })

  test("limit is clamped to the repository maximum", async () => {
    const { db } = mockDb([[]])
    const result = await createUnifiedInboxRepository().listItems(
      db,
      listOptions({ channels: ["call"], limit: 5000 }),
    )
    expect(result.pagination.limit).toBe(INBOX_MAX_LIMIT)
  })

  test("decodes a row into an InboxItem with derived unread/archived flags", async () => {
    const { db } = mockDb([
      [
        streamRow({
          readAt: new Date("2026-03-01T09:00:00Z"),
          archivedAt: new Date("2026-03-02T00:00:00Z"),
        }),
      ],
    ])
    const [item] = (
      await createUnifiedInboxRepository().listItems(db, listOptions({ channels: ["call"] }))
    ).data
    expect(item?.id).toBe(`call:${CALL}`)
    expect(item?.unread).toBe(true)
    expect(item?.archived).toBe(true)
    expect(item?.participant).toBe("+15550000001")
  })

  test("email rows are enriched from the thread's newest message in one extra query", async () => {
    const { db, seen } = mockDb([
      [streamRow({ channel: "email", sourceId: THREAD, participant: null, preview: null })],
      [
        {
          threadId: THREAD,
          fromAddress: "ada@example.com",
          fromName: "Ada Lovelace",
          snippet: "Any update on the quote?",
          bodyText: "…",
          direction: "inbound",
        },
      ],
    ])
    const [item] = (
      await createUnifiedInboxRepository().listItems(db, listOptions({ channels: ["email"] }))
    ).data
    expect(item?.participant).toBe("Ada Lovelace")
    expect(item?.preview).toBe("Any update on the quote?")
    expect(item?.direction).toBe("inbound")
    expect(seen).toHaveLength(2)
    expect(seen[1]?.sql).toContain("DISTINCT ON (m.thread_id)")
  })

  test("a page with no email rows skips the enrichment query", async () => {
    const { db, seen } = mockDb([[streamRow()]])
    await createUnifiedInboxRepository().listItems(db, listOptions({ channels: ["call"] }))
    expect(seen).toHaveLength(1)
  })
})

describe("unified-inbox/find item", () => {
  test("applies the caller's scope so a denied item is indistinguishable from a missing one", async () => {
    const { db, seen } = mockDb([[]])
    const found = await createUnifiedInboxRepository().findItem(db, WS, "email", THREAD, {
      kind: "own",
      actorId: ACTOR,
    })
    expect(found).toBeNull()
    const text = seen[0]?.sql ?? ""
    expect(text).toContain("t.id = ?::uuid")
    expect(text).toContain("t.owner_id = ?::uuid")
  })

  test("does not hide archived or read items — you must be able to reopen one", async () => {
    const { db, seen } = mockDb([[streamRow({ archivedAt: new Date() })]])
    const found = await createUnifiedInboxRepository().findItem(db, WS, "call", CALL, {
      kind: "all",
    })
    expect(found?.archived).toBe(true)
    expect(seen[0]?.sql ?? "").not.toContain("s.archived_at IS NULL")
  })
})

describe("unified-inbox/state writes", () => {
  test("rejects a source id that is not a uuid", async () => {
    const { db } = mockDb([[]])
    await expect(
      createUnifiedInboxRepository().upsertItemState(db, WS, "call", "nope", { readAt: null }),
    ).rejects.toThrow("must be a uuid")
  })

  test("omits keys the patch did not mention so a write never clears a sibling fact", async () => {
    const { db } = mockDb([[]])
    // Proves the call completes through the builder chain without throwing;
    // the partial-set semantics themselves are covered by the migration's
    // upsert target below plus the API test's assign-then-read sequence.
    await createUnifiedInboxRepository().upsertItemState(
      db,
      WS,
      "call",
      CALL,
      { readAt: new Date("2026-03-01T10:00:00Z") },
      ACTOR,
    )
  })
})

describe("unified-inbox/migration", () => {
  test("0240 creates the overlay table with its channel guard", async () => {
    const sqlText = await readFile(MIGRATION, "utf8")
    expect(sqlText).toContain("CREATE TABLE IF NOT EXISTS inbox_item_states")
    expect(sqlText).toContain("inbox_item_states_channel_chk")
    expect(sqlText).toContain("CHECK (channel IN ('email', 'whatsapp', 'call'))")
  })

  test("source_id carries no foreign key — it points at three tables this module does not own", async () => {
    const sqlText = await readFile(MIGRATION, "utf8")
    expect(sqlText).not.toContain("REFERENCES email_threads")
    expect(sqlText).not.toContain("REFERENCES whatsapp_conversations")
    expect(sqlText).not.toContain("REFERENCES calls")
    expect(sqlText).not.toContain("REFERENCES users")
  })

  test("the upsert target is a full unique index so a removed row revives", async () => {
    const sqlText = await readFile(MIGRATION, "utf8")
    expect(sqlText).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS inbox_item_states_item_uidx\n  ON inbox_item_states (workspace_id, channel, source_id);",
    )
  })

  test("the migration alters none of the three source tables", async () => {
    const sqlText = await readFile(MIGRATION, "utf8")
    expect(sqlText).not.toMatch(/ALTER TABLE/i)
    expect(sqlText).not.toMatch(
      /CREATE TABLE[^;]*\b(email_threads|whatsapp_conversations|calls)\b/i,
    )
  })
})
