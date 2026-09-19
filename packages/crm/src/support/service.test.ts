import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ServiceContext } from "../index"
import {
  createStore,
  expectAllowed,
  expectDenied,
  freezeTime,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
  type FrozenTime,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import {
  createSupportTicketService,
  type SupportTicketService,
  type SupportTicketCommentRecord,
  type SupportTicketRecord,
} from "./index"
import type { SupportTicketAuditInput, SupportTicketListQuery, SupportTicketStore } from "./types"

type StoredTicket = BaseRecord & {
  subject: string
  description: string | null
  status: string
  priority: string
  requesterId: string
  assigneeId: string | null
  channel: string
  firstResponseDueAt: Date | null
  firstResponseAt: Date | null
  resolutionDueAt: Date | null
  resolvedAt: Date | null
  closedAt: Date | null
}

type StoredComment = BaseRecord & {
  ticketId: string
  authorId: string
  body: string
  isInternal: boolean
}

function asTicket(row: StoredTicket): SupportTicketRecord {
  return row as unknown as SupportTicketRecord
}

function asComment(row: StoredComment): SupportTicketCommentRecord {
  return row as unknown as SupportTicketCommentRecord
}

/** Hermetic SupportTicketStore port backed by the shared in-memory store. */
function makeStore() {
  const tickets = createStore<StoredTicket>()
  const comments = createStore<StoredComment>()
  const store: SupportTicketStore = {
    list: async (workspaceId: string, query: SupportTicketListQuery) => {
      let rows = tickets.list(workspaceId)
      if (query.status) rows = rows.filter((r) => r.status === query.status)
      if (query.priority) rows = rows.filter((r) => r.priority === query.priority)
      if (query.assigneeId) rows = rows.filter((r) => r.assigneeId === query.assigneeId)
      if (query.requesterId) rows = rows.filter((r) => r.requesterId === query.requesterId)
      if (query.query) {
        const q = query.query.toLowerCase()
        rows = rows.filter((r) => r.subject.toLowerCase().includes(q))
      }
      const limit = Math.min(Math.max(query.limit ?? 25, 1), 200)
      const data = rows.slice(0, limit)
      return {
        data: data.map(asTicket),
        pagination: {
          nextCursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null,
          limit,
        },
      }
    },
    findById: async (workspaceId: string, id: string) => {
      const row = tickets.get(id, workspaceId)
      return row ? asTicket(row) : null
    },
    findWithComments: async (workspaceId: string, id: string) => {
      const row = tickets.get(id, workspaceId)
      if (!row) return null
      const rowComments = comments.list(workspaceId).filter((c) => c.ticketId === id)
      return { ticket: asTicket(row), comments: rowComments.map(asComment) }
    },
    create: async (workspaceId: string, input: Record<string, unknown>, actorId?: string) => {
      const record: StoredTicket = {
        ...makeBaseRecord({ workspaceId }),
        subject: input.subject as string,
        description: (input.description as string | null) ?? null,
        status: (input.status as string | null) ?? "new",
        priority: (input.priority as string | null) ?? "normal",
        requesterId: input.requesterId as string,
        assigneeId: (input.assigneeId as string | null) ?? null,
        channel: (input.channel as string | null) ?? "manual",
        firstResponseDueAt: (input.firstResponseDueAt as Date | null) ?? null,
        firstResponseAt: (input.firstResponseAt as Date | null) ?? null,
        resolutionDueAt: (input.resolutionDueAt as Date | null) ?? null,
        resolvedAt: (input.resolvedAt as Date | null) ?? null,
        closedAt: (input.closedAt as Date | null) ?? null,
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      }
      return asTicket(tickets.insert(record))
    },
    update: async (workspaceId: string, id: string, input: Record<string, unknown>) => {
      const row = tickets.update(id, workspaceId, input as Partial<StoredTicket>)
      return row ? asTicket(row) : null
    },
    softDelete: async (workspaceId: string, id: string) => {
      tickets.remove(id, workspaceId)
    },
    restore: async (workspaceId: string, id: string) => {
      tickets.restore(id, workspaceId)
    },
    addComment: async (
      workspaceId: string,
      ticketId: string,
      input: Record<string, unknown>,
      actorId: string,
    ) => {
      const record: StoredComment = {
        ...makeBaseRecord({ workspaceId }),
        ticketId,
        authorId: actorId,
        body: input.body as string,
        isInternal: (input.isInternal as boolean | undefined) ?? false,
        createdBy: actorId,
        updatedBy: actorId,
      }
      return asComment(comments.insert(record))
    },
  }
  return { tickets, comments, store }
}

function setup(
  role: "owner" | "admin" | "member" | "viewer" = "owner",
  shared?: ReturnType<typeof makeStore>,
  workspaceId?: string,
) {
  const session = makeSession({ role, ...(workspaceId === undefined ? {} : { workspaceId }) })
  const ctx = makeServiceContext({ session })
  const audits: SupportTicketAuditInput[] = []
  const backing = shared ?? makeStore()
  const service = createSupportTicketService({
    store: backing.store,
    audit: async (input) => void audits.push(input),
  })
  return { ctx, service, audits, session, backing }
}

async function seed(
  service: SupportTicketService,
  ctx: ServiceContext,
  overrides: { subject?: string; priority?: "low" | "normal" | "high" | "urgent" } = {},
) {
  return service.create(ctx, {
    subject: overrides.subject ?? "Cannot log in",
    requesterId: "person_1",
    ...(overrides.priority === undefined ? {} : { priority: overrides.priority }),
  })
}

describe("support/service", () => {
  let clock: FrozenTime

  beforeEach(() => {
    clock = freezeTime("2026-01-01T00:00:00.000Z")
  })

  afterEach(() => {
    clock.restore()
  })

  test("create validates, computes SLA due dates from priority, and audits with after", async () => {
    const { ctx, service, audits } = setup()
    const ticket = await expectAllowed(() => seed(service, ctx, { priority: "urgent" }))
    expect(ticket.subject).toBe("Cannot log in")
    expect(ticket.status).toBe("new")
    expect((ticket.firstResponseDueAt as Date).toISOString()).toBe("2026-01-01T01:00:00.000Z")
    expect((ticket.resolutionDueAt as Date).toISOString()).toBe("2026-01-01T04:00:00.000Z")
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ action: "create", object: "ticket", recordId: ticket.id })
  })

  test("create rejects invalid input before touching the store", async () => {
    const { ctx, service } = setup()
    await expect(service.create(ctx, { subject: "  ", requesterId: "person_1" })).rejects.toThrow()
    await expect(service.create(ctx, { subject: "Hi" })).rejects.toThrow()
  })

  test("SLA policy differs by priority", async () => {
    const { ctx, service } = setup()
    const low = await seed(service, ctx, { priority: "low" })
    const normal = await seed(service, ctx, { priority: "normal" })
    const high = await seed(service, ctx, { priority: "high" })
    expect((low.firstResponseDueAt as Date).toISOString()).toBe("2026-01-02T00:00:00.000Z")
    expect((normal.firstResponseDueAt as Date).toISOString()).toBe("2026-01-01T08:00:00.000Z")
    expect((high.firstResponseDueAt as Date).toISOString()).toBe("2026-01-01T04:00:00.000Z")
  })

  test("get returns the ticket with comments (empty at first); list paginates", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const found = await expectAllowed(() => service.get(ctx, created.id))
    expect(found.ticket.id).toBe(created.id)
    expect(found.comments).toEqual([])
    const listed = await expectAllowed(() => service.list(ctx, { limit: 25 }))
    expect(listed.data).toHaveLength(1)
    expect(listed.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("get throws NOT_FOUND for unknown ids", async () => {
    const { ctx, service } = setup()
    const err = await service.get(ctx, "missing").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe("NOT_FOUND")
  })

  test("update patches subject/assignee/channel and audits before/after", async () => {
    const { ctx, service, audits } = setup()
    const created = await seed(service, ctx)
    const updated = await expectAllowed(() =>
      service.update(ctx, created.id, { assigneeId: "user_9", channel: "email" }),
    )
    expect(updated.assigneeId).toBe("user_9")
    expect(updated.channel).toBe("email")
    expect(audits.at(-1)).toMatchObject({ action: "update", recordId: created.id })
  })

  test("update cannot set status directly (must go through transition)", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    // `status` is omitted from `updateSupportTicketSchema`, so a client
    // trying to smuggle it in either gets stripped (harmless) or, since the
    // patch would then be empty, a validation error. Either way the ticket
    // never silently jumps status outside `transition()`.
    const after = await service.update(ctx, created.id, { status: "closed", channel: "web" })
    expect(after.status).toBe("new")
  })

  test("raising priority before first response re-bases both due dates from creation time", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx, { priority: "normal" })
    expect((created.firstResponseDueAt as Date).toISOString()).toBe("2026-01-01T08:00:00.000Z")
    const updated = await service.update(ctx, created.id, { priority: "urgent" })
    expect((updated.firstResponseDueAt as Date).toISOString()).toBe("2026-01-01T01:00:00.000Z")
    expect((updated.resolutionDueAt as Date).toISOString()).toBe("2026-01-01T04:00:00.000Z")
  })

  test("priority change after first response leaves firstResponseDueAt alone but still moves resolutionDueAt", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx, { priority: "normal" })
    await service.addComment(ctx, created.id, { body: "We're on it", isInternal: false })
    const updated = await service.update(ctx, created.id, { priority: "urgent" })
    // firstResponseAt is already set, so firstResponseDueAt is history now.
    expect((updated.firstResponseDueAt as Date).toISOString()).toBe("2026-01-01T08:00:00.000Z")
    expect((updated.resolutionDueAt as Date).toISOString()).toBe("2026-01-01T04:00:00.000Z")
  })

  test("transition walks the lifecycle and stamps resolvedAt/closedAt; reopening clears both", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const opened = await expectAllowed(() =>
      service.transition(ctx, created.id, { status: "open" }),
    )
    expect(opened.status).toBe("open")
    const pending = await service.transition(ctx, created.id, { status: "pending" })
    expect(pending.status).toBe("pending")
    const backOpen = await service.transition(ctx, created.id, { status: "open" })
    expect(backOpen.status).toBe("open")
    const resolved = await service.transition(ctx, created.id, { status: "resolved" })
    expect(resolved.status).toBe("resolved")
    expect(resolved.resolvedAt).toEqual(clock.now)
    const closed = await service.transition(ctx, created.id, { status: "closed" })
    expect(closed.status).toBe("closed")
    expect(closed.closedAt).toEqual(clock.now)
    const reopened = await service.transition(ctx, created.id, { status: "open" })
    expect(reopened.status).toBe("open")
    expect(reopened.resolvedAt).toBeNull()
    expect(reopened.closedAt).toBeNull()
  })

  test("invalid transitions are rejected with a clear error, not silently allowed", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    // new -> pending is not a valid edge (must go through open first).
    const err = await service.transition(ctx, created.id, { status: "pending" }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe("INVALID_TRANSITION")
    expect((err as Error).message).toContain("new")
    expect((err as Error).message).toContain("pending")

    // closed -> resolved is not a valid edge either (must reopen first).
    await service.transition(ctx, created.id, { status: "open" })
    await service.transition(ctx, created.id, { status: "closed" })
    const err2 = await service.transition(ctx, created.id, { status: "resolved" }).catch((e) => e)
    expect((err2 as { code?: string }).code).toBe("INVALID_TRANSITION")
  })

  test("the first public comment stamps firstResponseAt exactly once; internal notes never do", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    expect(created.firstResponseAt).toBeNull()

    const afterInternal = await service.addComment(ctx, created.id, {
      body: "Checking logs internally",
      isInternal: true,
    })
    expect(afterInternal.ticket.firstResponseAt).toBeNull()

    const afterPublic = await service.addComment(ctx, created.id, {
      body: "We're looking into this now",
      isInternal: false,
    })
    expect(afterPublic.ticket.firstResponseAt).toEqual(clock.now)

    // A second public reply must not move firstResponseAt.
    clock.restore()
    clock = freezeTime("2026-01-02T00:00:00.000Z")
    const afterSecond = await service.addComment(ctx, created.id, {
      body: "Following up",
      isInternal: false,
    })
    expect(afterSecond.ticket.firstResponseAt).toEqual(new Date("2026-01-01T00:00:00.000Z"))
  })

  test("internal notes never appear in the requester-safe view; public comments do", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    await service.addComment(ctx, created.id, { body: "Internal only", isInternal: true })
    await service.addComment(ctx, created.id, {
      body: "Visible to the requester",
      isInternal: false,
    })

    const staffView = await service.get(ctx, created.id)
    expect(staffView.comments).toHaveLength(2)

    const requesterView = await service.getForRequester(ctx, created.id)
    expect(requesterView.comments).toHaveLength(1)
    expect(requesterView.comments[0]?.body).toBe("Visible to the requester")
    expect(requesterView.comments.some((c) => c.isInternal === true)).toBe(false)
  })

  test("softDelete hides the ticket; restore revives it", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    await expectAllowed(() => service.softDelete(ctx, created.id))
    await expect(service.get(ctx, created.id)).rejects.toMatchObject({ code: "NOT_FOUND" })
    const restored = await expectAllowed(() => service.restore(ctx, created.id))
    expect(restored.id).toBe(created.id)
    await expectAllowed(() => service.get(ctx, created.id))
  })

  describe("denials", () => {
    let backing: ReturnType<typeof makeStore>
    let workspaceId: string
    let ticketId: string

    function asRole(role: "owner" | "admin" | "member" | "viewer") {
      return setup(role, backing, workspaceId)
    }

    beforeEach(async () => {
      backing = makeStore()
      const owner = setup("owner", backing)
      workspaceId = owner.ctx.workspaceId
      ticketId = (await seed(owner.service, owner.ctx)).id
    })

    test("viewer cannot create", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => seed(service, ctx))
    })

    test("viewer cannot update", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.update(ctx, ticketId, { channel: "email" }))
    })

    test("viewer cannot transition or comment", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.transition(ctx, ticketId, { status: "open" }))
      await expectDenied(() => service.addComment(ctx, ticketId, { body: "Hi" }))
    })

    test("member cannot delete (admin-only)", async () => {
      const { ctx, service } = asRole("member")
      await expectDenied(() => service.softDelete(ctx, ticketId))
    })

    test("viewer can still list and get (read is open)", async () => {
      const { ctx, service } = asRole("viewer")
      await expectAllowed(() => service.list(ctx, {}))
      await expectAllowed(() => service.get(ctx, ticketId))
    })
  })
})
