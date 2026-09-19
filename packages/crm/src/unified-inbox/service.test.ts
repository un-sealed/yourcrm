import { beforeEach, describe, expect, test } from "bun:test"
import { expectDenied, makeServiceContext, makeSession } from "@yourcrm/testing"
import { createUnifiedInboxService, InboxItemNotFoundError, readWatermark } from "./service"
import type {
  InboxAuditInput,
  InboxChannelName,
  InboxItemRecord,
  InboxStatePatch,
  InboxStore,
  InboxStoreQuery,
  InboxVisibility,
} from "./types"

const WS = "11111111-1111-4111-8111-111111111111"
const ADMIN = "22222222-2222-4222-8222-222222222222"
const MEMBER = "33333333-3333-4333-8333-333333333333"
const OTHER = "44444444-4444-4444-8444-444444444444"
const PERSON = "55555555-5555-4555-8555-555555555555"

const EMAIL_ID = "aaaaaaaa-0000-4000-8000-000000000001"
const WHATSAPP_ID = "bbbbbbbb-0000-4000-8000-000000000002"
const CALL_ID = "cccccccc-0000-4000-8000-000000000003"
const MEMBER_EMAIL_ID = "dddddddd-0000-4000-8000-000000000004"

/** Mirrors `encodeInboxCursor` in the repository (the crm layer cannot import it). */
function encodeCursor(sortAt: Date, sourceId: string): string {
  return btoa(`${sortAt.toISOString()}|${sourceId}`)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
}

function decodeCursor(cursor?: string): { sortAt: Date; sourceId: string } | null {
  if (!cursor) return null
  const raw = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"))
  const at = raw.indexOf("|")
  return { sortAt: new Date(raw.slice(0, at)), sourceId: raw.slice(at + 1) }
}

type SourceRow = {
  channel: InboxChannelName
  sourceId: string
  sortAt: Date
  ownerId: string | null
  createdBy: string | null
  personId: string | null
}

type OverlayRow = {
  assignedTo: string | null
  assignedAt: Date | null
  assignedBy: string | null
  readAt: Date | null
  archivedAt: Date | null
}

/**
 * Hermetic store fake. It reproduces the *semantics* the SQL repository
 * implements — the (sortAt, sourceId) total order, the keyset cursor, the
 * `own` visibility predicate and the read watermark — so these tests exercise
 * the service's contract without a Postgres (`docs/conventions.md`).
 */
function makeStore(rows: SourceRow[]) {
  const overlay = new Map<string, OverlayRow>()
  const blank = (): OverlayRow => ({
    assignedTo: null,
    assignedAt: null,
    assignedBy: null,
    readAt: null,
    archivedAt: null,
  })
  const key = (channel: string, sourceId: string) => `${channel}:${sourceId}`

  const toItem = (row: SourceRow): InboxItemRecord => {
    const state = overlay.get(key(row.channel, row.sourceId)) ?? blank()
    return {
      id: key(row.channel, row.sourceId),
      channel: row.channel,
      sourceId: row.sourceId,
      workspaceId: WS,
      sortAt: row.sortAt,
      ownerId: row.ownerId,
      personId: row.personId,
      ...state,
      unread: state.readAt === null || state.readAt.getTime() < row.sortAt.getTime(),
      archived: state.archivedAt !== null,
    }
  }

  const visible = (row: SourceRow, scope: InboxVisibility): boolean => {
    if (scope.kind === "all") return true
    const state = overlay.get(key(row.channel, row.sourceId)) ?? blank()
    return (
      row.ownerId === scope.actorId ||
      row.createdBy === scope.actorId ||
      state.assignedTo === scope.actorId ||
      (row.ownerId === null && state.assignedTo === null)
    )
  }

  const store: InboxStore = {
    list: async (_workspaceId: string, query: InboxStoreQuery) => {
      const limit = query.limit ?? 25
      const descending = query.order !== "asc"
      const cursor = decodeCursor(query.cursor)
      let matching = rows
        .filter((row) => query.channels.includes(row.channel))
        .filter((row) => visible(row, query.scope))
        .filter((row) => {
          const state = overlay.get(key(row.channel, row.sourceId)) ?? blank()
          const unread = state.readAt === null || state.readAt.getTime() < row.sortAt.getTime()
          if (query.unread !== undefined && unread !== query.unread) return false
          if (query.archived !== undefined && (state.archivedAt !== null) !== query.archived) {
            return false
          }
          const assignment = query.assignment ?? { kind: "any" }
          if (assignment.kind === "unassigned" && state.assignedTo !== null) return false
          if (assignment.kind === "user" && state.assignedTo !== assignment.userId) return false
          if (query.personId !== undefined && row.personId !== query.personId) return false
          return true
        })
        .sort((a, b) => {
          const byTime = a.sortAt.getTime() - b.sortAt.getTime()
          const ordered = byTime !== 0 ? byTime : a.sourceId.localeCompare(b.sourceId)
          return descending ? -ordered : ordered
        })
      if (cursor) {
        matching = matching.filter((row) => {
          const byTime = row.sortAt.getTime() - cursor.sortAt.getTime()
          const ordered = byTime !== 0 ? byTime : row.sourceId.localeCompare(cursor.sourceId)
          return descending ? ordered < 0 : ordered > 0
        })
      }
      const page = matching.slice(0, limit)
      const hasMore = matching.length > limit
      const last = page[page.length - 1]
      return {
        data: page.map(toItem),
        pagination: {
          nextCursor: hasMore && last ? encodeCursor(last.sortAt, last.sourceId) : null,
          limit,
        },
      }
    },
    findItem: async (
      _workspaceId: string,
      channel: InboxChannelName,
      sourceId: string,
      scope: InboxVisibility,
    ) => {
      const row = rows.find((entry) => entry.channel === channel && entry.sourceId === sourceId)
      if (!row || !visible(row, scope)) return null
      return toItem(row)
    },
    setState: async (
      _workspaceId: string,
      channel: InboxChannelName,
      sourceId: string,
      patch: InboxStatePatch,
    ) => {
      const id = key(channel, sourceId)
      const current = overlay.get(id) ?? blank()
      overlay.set(id, {
        assignedTo: patch.assignedTo === undefined ? current.assignedTo : patch.assignedTo,
        assignedAt: patch.assignedAt === undefined ? current.assignedAt : patch.assignedAt,
        assignedBy: patch.assignedBy === undefined ? current.assignedBy : patch.assignedBy,
        readAt: patch.readAt === undefined ? current.readAt : patch.readAt,
        archivedAt: patch.archivedAt === undefined ? current.archivedAt : patch.archivedAt,
      })
    },
  }
  return { store, overlay }
}

const SHARED_AT = new Date("2026-03-01T10:00:00Z")

function seedRows(): SourceRow[] {
  return [
    // Three sources, one identical timestamp — the ordering-stability fixture.
    {
      channel: "email",
      sourceId: EMAIL_ID,
      sortAt: SHARED_AT,
      ownerId: ADMIN,
      createdBy: ADMIN,
      personId: PERSON,
    },
    {
      channel: "whatsapp",
      sourceId: WHATSAPP_ID,
      sortAt: SHARED_AT,
      ownerId: null,
      createdBy: OTHER,
      personId: null,
    },
    {
      channel: "call",
      sourceId: CALL_ID,
      sortAt: SHARED_AT,
      ownerId: OTHER,
      createdBy: OTHER,
      personId: null,
    },
    {
      channel: "email",
      sourceId: MEMBER_EMAIL_ID,
      sortAt: new Date("2026-03-01T09:00:00Z"),
      ownerId: MEMBER,
      createdBy: MEMBER,
      personId: null,
    },
  ]
}

let audits: InboxAuditInput[] = []

function makeService(rows: SourceRow[] = seedRows()) {
  audits = []
  const { store, overlay } = makeStore(rows)
  const service = createUnifiedInboxService({
    store,
    audit: async (input) => {
      audits.push(input)
    },
  })
  return { service, store, overlay }
}

const adminCtx = () =>
  makeServiceContext({ session: makeSession({ role: "admin", workspaceId: WS, userId: ADMIN }) })
const memberCtx = () =>
  makeServiceContext({ session: makeSession({ role: "member", workspaceId: WS, userId: MEMBER }) })
const viewerCtx = () =>
  makeServiceContext({ session: makeSession({ role: "viewer", workspaceId: WS, userId: MEMBER }) })

beforeEach(() => {
  audits = []
})

describe("unified-inbox/list", () => {
  test("merges all three channels into one ordered stream", async () => {
    const { service } = makeService()
    const result = await service.list(adminCtx(), {})
    // Three sources share one timestamp, so the deterministic tiebreak —
    // sourceId, descending — decides: cccc… (call), bbbb… (whatsapp),
    // aaaa… (email); then the older email thread.
    expect(result.data.map((item) => item.channel)).toEqual(["call", "whatsapp", "email", "email"])
    expect(result.pagination.limit).toBe(25)
  })

  test("a channel filter narrows the stream to that source", async () => {
    const { service } = makeService()
    const result = await service.list(adminCtx(), { channel: "whatsapp" })
    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.sourceId).toBe(WHATSAPP_ID)
  })

  test("rejects an unknown channel instead of silently listing everything", async () => {
    const { service } = makeService()
    await expect(service.list(adminCtx(), { channel: "telegram" })).rejects.toThrow()
  })
})

describe("unified-inbox/permissions", () => {
  test("a lower-privileged actor sees strictly fewer items than an admin", async () => {
    const { service } = makeService()
    const asAdmin = await service.list(adminCtx(), {})
    const asMember = await service.list(memberCtx(), {})

    expect(asAdmin.data).toHaveLength(4)
    // The member keeps their own thread plus the unowned+unassigned shared
    // queue, and loses the admin's thread and the other rep's call.
    expect(asMember.data.map((item) => item.sourceId)).toEqual([WHATSAPP_ID, MEMBER_EMAIL_ID])
    expect(asMember.data.length).toBeLessThan(asAdmin.data.length)
  })

  test("assigning a conversation to a member brings it into their stream", async () => {
    const { service } = makeService()
    await service.assign(adminCtx(), { channel: "call", sourceId: CALL_ID }, { assigneeId: MEMBER })
    const asMember = await service.list(memberCtx(), {})
    expect(asMember.data.map((item) => item.sourceId)).toContain(CALL_ID)
  })

  test("an item the caller may not see is a 404, not a 403 — existence never leaks", async () => {
    const { service } = makeService()
    await expect(
      service.get(memberCtx(), { channel: "email", sourceId: EMAIL_ID }),
    ).rejects.toBeInstanceOf(InboxItemNotFoundError)
  })

  test("mutating an invisible item fails the same way", async () => {
    const { service } = makeService()
    await expect(
      service.archive(memberCtx(), { channel: "email", sourceId: EMAIL_ID }),
    ).rejects.toBeInstanceOf(InboxItemNotFoundError)
  })

  test("a viewer may read the stream but not assign", async () => {
    const { service } = makeService()
    const readable = await service.list(viewerCtx(), {})
    expect(readable.data.length).toBeGreaterThan(0)

    const denied = await expectDenied(() =>
      service.assign(
        viewerCtx(),
        { channel: "whatsapp", sourceId: WHATSAPP_ID },
        { assigneeId: MEMBER },
      ),
    )
    expect(denied.ctx.action).toBe("update")
    expect(denied.ctx.object).toBe("inbox_conversation")
  })

  test("a viewer may not mark read or archive either", async () => {
    const { service } = makeService()
    await expectDenied(() => service.markRead(viewerCtx(), { channel: "call", sourceId: CALL_ID }))
    await expectDenied(() => service.archive(viewerCtx(), { channel: "call", sourceId: CALL_ID }))
    await expectDenied(() => service.unassign(viewerCtx(), { channel: "call", sourceId: CALL_ID }))
  })

  test("a denied read never reaches the store", async () => {
    const { service } = makeService()
    // An actor with no workspace fails the foundation policy outright.
    await expectDenied(() =>
      service.list(makeServiceContext({ workspaceId: "", actorId: ADMIN, role: "owner" }), {}),
    )
  })
})

describe("unified-inbox/ordering stability", () => {
  test("paging one item at a time over a three-way timestamp tie loses and repeats nothing", async () => {
    const { service } = makeService()
    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const result: Awaited<ReturnType<typeof service.list>> = await service.list(adminCtx(), {
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      })
      if (result.data.length === 0) break
      for (const item of result.data) seen.push(item.id)
      if (result.pagination.nextCursor === null) break
      cursor = result.pagination.nextCursor
    }
    expect(seen).toHaveLength(4)
    expect(new Set(seen).size).toBe(4)
    const oneShot = await service.list(adminCtx(), { limit: 50 })
    expect(seen).toEqual(oneShot.data.map((item) => item.id))
  })

  test("ascending order is the exact reverse of descending", async () => {
    const { service } = makeService()
    const desc = await service.list(adminCtx(), { order: "desc" })
    const asc = await service.list(adminCtx(), { order: "asc" })
    expect(asc.data.map((item) => item.id)).toEqual(desc.data.map((item) => item.id).reverse())
  })
})

describe("unified-inbox/filters", () => {
  test("unread and read are complementary views of the same stream", async () => {
    const { service } = makeService()
    await service.markRead(adminCtx(), { channel: "call", sourceId: CALL_ID })
    const unread = await service.list(adminCtx(), { unread: "true" })
    const read = await service.list(adminCtx(), { unread: "false" })
    expect(read.data.map((item) => item.sourceId)).toEqual([CALL_ID])
    expect(unread.data.map((item) => item.sourceId)).not.toContain(CALL_ID)
    expect(unread.data.length + read.data.length).toBe(4)
  })

  test("archived items are hidden by default and listable on request", async () => {
    const { service } = makeService()
    await service.archive(adminCtx(), { channel: "whatsapp", sourceId: WHATSAPP_ID })
    const live = await service.list(adminCtx(), {})
    const archived = await service.list(adminCtx(), { archived: "true" })
    expect(live.data.map((item) => item.sourceId)).not.toContain(WHATSAPP_ID)
    expect(archived.data.map((item) => item.sourceId)).toEqual([WHATSAPP_ID])
  })

  test("assigned-to-me resolves to the caller", async () => {
    const { service } = makeService()
    await service.assign(adminCtx(), { channel: "call", sourceId: CALL_ID }, { assigneeId: ADMIN })
    const mine = await service.list(adminCtx(), { assigned: "me" })
    expect(mine.data.map((item) => item.sourceId)).toEqual([CALL_ID])
  })

  test("unassigned excludes anything with an assignee", async () => {
    const { service } = makeService()
    await service.assign(adminCtx(), { channel: "call", sourceId: CALL_ID }, { assigneeId: ADMIN })
    const unassigned = await service.list(adminCtx(), { assigned: "unassigned" })
    expect(unassigned.data.map((item) => item.sourceId)).not.toContain(CALL_ID)
    expect(unassigned.data).toHaveLength(3)
  })

  test("an explicit assignedTo wins over assigned=me", async () => {
    const { service } = makeService()
    await service.assign(adminCtx(), { channel: "call", sourceId: CALL_ID }, { assigneeId: OTHER })
    const result = await service.list(adminCtx(), { assigned: "me", assignedTo: OTHER })
    expect(result.data.map((item) => item.sourceId)).toEqual([CALL_ID])
  })

  test("a linked-record filter narrows to conversations on that record", async () => {
    const { service } = makeService()
    const result = await service.list(adminCtx(), { personId: PERSON })
    expect(result.data.map((item) => item.sourceId)).toEqual([EMAIL_ID])
  })
})

describe("unified-inbox/assignment", () => {
  test("assign stamps the assignee, the time and who did it", async () => {
    const { service, overlay } = makeService()
    const item = await service.assign(
      adminCtx(),
      { channel: "whatsapp", sourceId: WHATSAPP_ID },
      { assigneeId: MEMBER },
    )
    expect(item.assignedTo).toBe(MEMBER)
    expect(overlay.get(`whatsapp:${WHATSAPP_ID}`)?.assignedBy).toBe(ADMIN)
    expect(overlay.get(`whatsapp:${WHATSAPP_ID}`)?.assignedAt).toBeInstanceOf(Date)
  })

  test("assigning null unassigns, exactly like the unassign method", async () => {
    const { service } = makeService()
    const ref = { channel: "whatsapp", sourceId: WHATSAPP_ID }
    await service.assign(adminCtx(), ref, { assigneeId: MEMBER })
    const cleared = await service.assign(adminCtx(), ref, { assigneeId: null })
    expect(cleared.assignedTo).toBeNull()
    expect(audits.map((entry) => entry.action)).toEqual(["assign", "unassign"])
  })

  test("claim assigns the conversation to the caller", async () => {
    const { service, overlay } = makeService()
    const item = await service.claim(adminCtx(), { channel: "whatsapp", sourceId: WHATSAPP_ID })
    expect(item.assignedTo).toBe(ADMIN)
    expect(overlay.get(`whatsapp:${WHATSAPP_ID}`)?.assignedBy).toBe(ADMIN)
    expect(audits.map((entry) => entry.action)).toEqual(["assign"])
  })

  test("a viewer may not claim", async () => {
    const { service } = makeService()
    await expectDenied(() =>
      service.claim(viewerCtx(), { channel: "whatsapp", sourceId: WHATSAPP_ID }),
    )
  })

  test("a non-uuid assignee is rejected at the boundary", async () => {
    const { service } = makeService()
    await expect(
      service.assign(
        adminCtx(),
        { channel: "whatsapp", sourceId: WHATSAPP_ID },
        { assigneeId: "someone" },
      ),
    ).rejects.toThrow()
  })

  test("assignment does not disturb read state", async () => {
    const { service, overlay } = makeService()
    const ref = { channel: "call", sourceId: CALL_ID }
    await service.markRead(adminCtx(), ref)
    await service.assign(adminCtx(), ref, { assigneeId: MEMBER })
    expect(overlay.get(`call:${CALL_ID}`)?.readAt).toBeInstanceOf(Date)
    expect(overlay.get(`call:${CALL_ID}`)?.assignedTo).toBe(MEMBER)
  })
})

describe("unified-inbox/read state", () => {
  test("mark read stamps the item's own last activity, not now()", async () => {
    const { service, overlay } = makeService()
    await service.markRead(adminCtx(), { channel: "call", sourceId: CALL_ID })
    expect(overlay.get(`call:${CALL_ID}`)?.readAt?.toISOString()).toBe(SHARED_AT.toISOString())
  })

  test("a later message makes a read item unread again without any inbox write", async () => {
    const rows = seedRows()
    const { service } = makeService(rows)
    const ref = { channel: "call", sourceId: CALL_ID }
    expect((await service.markRead(adminCtx(), ref)).unread).toBe(false)

    // Simulate the Calling module recording a newer activity on its own row.
    const call = rows.find((row) => row.sourceId === CALL_ID)
    if (call) call.sortAt = new Date("2026-03-01T12:00:00Z")

    expect((await service.get(adminCtx(), ref)).unread).toBe(true)
  })

  test("mark unread clears the watermark", async () => {
    const { service, overlay } = makeService()
    const ref = { channel: "call", sourceId: CALL_ID }
    await service.markRead(adminCtx(), ref)
    const item = await service.markUnread(adminCtx(), ref)
    expect(item.unread).toBe(true)
    expect(overlay.get(`call:${CALL_ID}`)?.readAt).toBeNull()
  })

  test("readWatermark falls back to now when the store reports no timestamp", () => {
    const now = new Date("2026-05-05T05:05:05Z")
    const item: InboxItemRecord = { id: "call:x", channel: "call", sourceId: "x" }
    expect(readWatermark(item, now)).toBe(now)
    expect(readWatermark({ ...item, sortAt: "2026-03-01T10:00:00Z" }, now).toISOString()).toBe(
      SHARED_AT.toISOString(),
    )
  })
})

describe("unified-inbox/archive", () => {
  test("archive then unarchive round-trips", async () => {
    const { service } = makeService()
    const ref = { channel: "call", sourceId: CALL_ID }
    expect((await service.archive(adminCtx(), ref)).archived).toBe(true)
    expect((await service.unarchive(adminCtx(), ref)).archived).toBe(false)
  })

  test("an archived item is still openable", async () => {
    const { service } = makeService()
    const ref = { channel: "call", sourceId: CALL_ID }
    await service.archive(adminCtx(), ref)
    expect((await service.get(adminCtx(), ref)).id).toBe(`call:${CALL_ID}`)
  })
})

describe("unified-inbox/audit", () => {
  test("every mutation writes an audit row with before, after and correlation id", async () => {
    const { service } = makeService()
    const ctx = adminCtx()
    const ref = { channel: "call", sourceId: CALL_ID }
    await service.assign(ctx, ref, { assigneeId: MEMBER })
    await service.markRead(ctx, ref)
    await service.archive(ctx, ref)
    await service.unarchive(ctx, ref)
    await service.markUnread(ctx, ref)
    await service.unassign(ctx, ref)

    expect(audits.map((entry) => entry.action)).toEqual([
      "assign",
      "mark_read",
      "archive",
      "unarchive",
      "mark_unread",
      "unassign",
    ])
    for (const entry of audits) {
      expect(entry.object).toBe("inbox_conversation")
      expect(entry.recordId).toBe(`call:${CALL_ID}`)
      expect(entry.workspaceId).toBe(WS)
      expect(entry.actorId).toBe(ADMIN)
      expect(entry.correlationId).toBe(ctx.correlationId)
      expect(entry.before).toBeDefined()
      expect(entry.after).toBeDefined()
    }
  })

  test("reading writes no audit row", async () => {
    const { service } = makeService()
    await service.list(adminCtx(), {})
    await service.get(adminCtx(), { channel: "call", sourceId: CALL_ID })
    expect(audits).toHaveLength(0)
  })

  test("a denied mutation writes nothing", async () => {
    const { service } = makeService()
    await expectDenied(() =>
      service.assign(
        viewerCtx(),
        { channel: "whatsapp", sourceId: WHATSAPP_ID },
        { assigneeId: MEMBER },
      ),
    )
    expect(audits).toHaveLength(0)
  })
})
