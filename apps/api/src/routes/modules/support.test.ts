import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import { createSupportTicketService, type SupportTicketService } from "@yourcrm/crm/src/support"
import type {
  SupportTicketCommentRecord,
  SupportTicketRecord,
  SupportTicketStore,
} from "@yourcrm/crm/src/support"
import {
  createApiClient,
  createStore,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes } from "./support"

type StoredTicket = BaseRecord & {
  subject: string
  status: string
  priority: string
  requesterId: string
  assigneeId: string | null
  firstResponseAt: Date | null
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

/** Real domain service over a hermetic in-memory store. */
function makeFakeService() {
  const tickets = createStore<StoredTicket>()
  const comments = createStore<StoredComment>()
  const store: SupportTicketStore = {
    list: async (workspaceId, query) => {
      let rows = tickets.list(workspaceId)
      if (query.status) rows = rows.filter((r) => r.status === query.status)
      const limit = query.limit ?? 25
      const data = rows.slice(0, limit)
      return {
        data: data.map(asTicket),
        pagination: {
          nextCursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null,
          limit,
        },
      }
    },
    findById: async (workspaceId, id) => {
      const row = tickets.get(id, workspaceId)
      return row ? asTicket(row) : null
    },
    findWithComments: async (workspaceId, id) => {
      const row = tickets.get(id, workspaceId)
      if (!row) return null
      const rowComments = comments.list(workspaceId).filter((c) => c.ticketId === id)
      return { ticket: asTicket(row), comments: rowComments.map(asComment) }
    },
    create: async (workspaceId, input, actorId) => {
      const created = tickets.insert({
        ...makeBaseRecord({ workspaceId }),
        subject: input.subject as string,
        status: "new",
        priority: (input.priority as string | null) ?? "normal",
        requesterId: input.requesterId as string,
        assigneeId: (input.assigneeId as string | null) ?? null,
        firstResponseAt: null,
        resolvedAt: null,
        closedAt: null,
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      })
      return asTicket(created)
    },
    update: async (workspaceId, id, input) => {
      const row = tickets.update(id, workspaceId, input as Partial<StoredTicket>)
      return row ? asTicket(row) : null
    },
    softDelete: async (workspaceId, id) => {
      tickets.remove(id, workspaceId)
    },
    restore: async (workspaceId, id) => {
      tickets.restore(id, workspaceId)
    },
    addComment: async (workspaceId, ticketId, input, actorId) => {
      const created = comments.insert({
        ...makeBaseRecord({ workspaceId }),
        ticketId,
        authorId: actorId,
        body: input.body as string,
        isInternal: (input.isInternal as boolean | undefined) ?? false,
        createdBy: actorId,
        updatedBy: actorId,
      })
      return asComment(created)
    },
  }
  return createSupportTicketService({ store, audit: async () => undefined })
}

/**
 * Hermetic API test: the route factory takes a service, so tests inject the
 * real domain service over an in-memory store. Sessions ride a tiny test-only
 * middleware (role-accurate without touching the foundation auth hook).
 */
function makeTestApp(session: { current: Session | null }, service: SupportTicketService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/tickets", createRoutes({ service }))
  return app
}

describe("api/tickets", () => {
  let session: { current: Session | null }
  let service: SupportTicketService
  let ctx: ReturnType<typeof makeServiceContext>

  beforeEach(() => {
    const owner = makeSession({ role: "owner" })
    ctx = makeServiceContext({ session: owner })
    session = { current: owner }
    service = makeFakeService()
  })

  test("unauthenticated requests get UNAUTHORIZED", async () => {
    session.current = null
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/tickets")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("list returns the cursor pagination envelope", async () => {
    await service.create(ctx, { subject: "Cannot log in", requesterId: "person_1" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/tickets")
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("get returns the ticket with its comment thread; unknown id is NOT_FOUND", async () => {
    const created = await service.create(ctx, { subject: "Cannot log in", requesterId: "person_1" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const ok = await api.get(`/api/v1/tickets/${created.id}`)
    expect(ok.status).toBe(200)
    const data = ok.expectSuccess().data as { id: string; comments: unknown[] }
    expect(data.id).toBe(created.id)
    expect(data.comments).toEqual([])
    const missing = await api.get("/api/v1/tickets/does-not-exist")
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")
  })

  test("create validates the body and returns 201", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const bad = await api.post("/api/v1/tickets", { subject: "  " })
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")
    const good = await api.post("/api/v1/tickets", {
      subject: "Cannot log in",
      requesterId: "person_1",
    })
    expect(good.status).toBe(201)
    const data = good.expectSuccess().data as { subject: string; status: string }
    expect(data.subject).toBe("Cannot log in")
    expect(data.status).toBe("new")
  })

  test("viewer create is FORBIDDEN (service denial maps to 403)", async () => {
    session.current = makeSession({ role: "viewer", workspaceId: ctx.workspaceId })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/tickets", { subject: "Nope", requesterId: "person_1" })
    expect(res.status).toBe(403)
    const err = res.expectError("FORBIDDEN")
    expect(err.error.message).toContain("create")
  })

  test("update, delete and restore round-trip", async () => {
    const created = await service.create(ctx, { subject: "Cannot log in", requesterId: "person_1" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const patched = await api.patch(`/api/v1/tickets/${created.id}`, {
      subject: "Still cannot log in",
    })
    expect(patched.status).toBe(200)
    const deleted = await api.delete(`/api/v1/tickets/${created.id}`)
    expect(deleted.status).toBe(200)
    const gone = await api.get(`/api/v1/tickets/${created.id}`)
    expect(gone.status).toBe(404)
    const restored = await api.post(`/api/v1/tickets/${created.id}/restore`)
    expect(restored.status).toBe(200)
    const back = await api.get(`/api/v1/tickets/${created.id}`)
    expect(back.status).toBe(200)
  })

  test("status transitions: valid edges succeed, invalid edges are 409 INVALID_TRANSITION", async () => {
    const created = await service.create(ctx, { subject: "Cannot log in", requesterId: "person_1" })
    const api = createApiClient({ app: makeTestApp(session, service) })

    // new -> pending is not a valid edge (must go through open first).
    const badTransition = await api.post(`/api/v1/tickets/${created.id}/status`, {
      status: "pending",
    })
    expect(badTransition.status).toBe(409)
    badTransition.expectError("INVALID_TRANSITION")

    const opened = await api.post(`/api/v1/tickets/${created.id}/status`, { status: "open" })
    expect(opened.status).toBe(200)
    expect((opened.expectSuccess().data as { status: string }).status).toBe("open")

    const resolved = await api.post(`/api/v1/tickets/${created.id}/status`, { status: "resolved" })
    expect(resolved.status).toBe(200)
    expect((resolved.expectSuccess().data as { status: string }).status).toBe("resolved")
  })

  test("a generic PATCH cannot smuggle a status change", async () => {
    const created = await service.create(ctx, { subject: "Cannot log in", requesterId: "person_1" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.patch(`/api/v1/tickets/${created.id}`, {
      status: "closed",
      assigneeId: "user_9",
    })
    expect(res.status).toBe(200)
    const data = res.expectSuccess().data as { status: string; assigneeId: string }
    expect(data.status).toBe("new")
    expect(data.assigneeId).toBe("user_9")
  })

  test("comments: internal notes are returned to staff but flagged, and never silently promoted to public", async () => {
    const created = await service.create(ctx, { subject: "Cannot log in", requesterId: "person_1" })
    const api = createApiClient({ app: makeTestApp(session, service) })

    const publicReply = await api.post(`/api/v1/tickets/${created.id}/comments`, {
      body: "We're looking into this",
      isInternal: false,
    })
    expect(publicReply.status).toBe(201)

    const internalNote = await api.post(`/api/v1/tickets/${created.id}/comments`, {
      body: "Looks like a cache issue",
      isInternal: true,
    })
    expect(internalNote.status).toBe(201)
    const internalData = internalNote.expectSuccess().data as {
      comment: { isInternal: boolean; body: string }
      ticket: { firstResponseAt: unknown }
    }
    expect(internalData.comment.isInternal).toBe(true)
    // firstResponseAt was already stamped by the public reply above; an
    // internal note must not be able to change that.
    expect(internalData.ticket.firstResponseAt).not.toBeNull()

    const detail = await api.get(`/api/v1/tickets/${created.id}`)
    const comments = (detail.expectSuccess().data as { comments: { isInternal: boolean }[] })
      .comments
    expect(comments).toHaveLength(2)
    expect(comments.filter((c) => c.isInternal).length).toBe(1)
    // The staff `GET /:id` endpoint is the only P0 route that reads comments
    // at all — there is no requester-facing route in this module (the
    // customer portal, spec 45, is out of scope), so there is nothing here
    // for an internal note to leak through. The filtering guarantee itself
    // (`SupportTicketService.getForRequester`) is proven in
    // `packages/crm/src/support/service.test.ts`.
  })
})
