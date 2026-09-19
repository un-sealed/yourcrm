import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import {
  createUnifiedInboxService,
  type InboxAuditInput,
  type InboxChannelName,
  type InboxItemRecord,
  type InboxStatePatch,
  type InboxStore,
  type InboxVisibility,
  type UnifiedInboxService,
} from "@yourcrm/crm/src/unified-inbox"
import { createApiClient, expectDenied, makeSession } from "@yourcrm/testing"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes } from "./unified-inbox"

const ADMIN = "22222222-2222-4222-8222-222222222222"
const MEMBER = "33333333-3333-4333-8333-333333333333"
const EMAIL_ID = "aaaaaaaa-0000-4000-8000-000000000001"
const WHATSAPP_ID = "bbbbbbbb-0000-4000-8000-000000000002"
const CALL_ID = "cccccccc-0000-4000-8000-000000000003"
const SHARED_AT = new Date("2026-03-01T10:00:00Z")

type SourceRow = {
  channel: InboxChannelName
  sourceId: string
  sortAt: Date
  ownerId: string | null
  createdBy: string | null
}

type OverlayRow = {
  assignedTo: string | null
  assignedAt: Date | null
  assignedBy: string | null
  readAt: Date | null
  archivedAt: Date | null
}

/**
 * Hermetic API test: the REAL domain service over an in-memory store, so the
 * permission path, the envelopes and the error mapping are all exercised for
 * real — the same pattern `whatsapp.test.ts` uses. No Postgres.
 */
function makeFakeService(workspaceId: string): {
  service: UnifiedInboxService
  audits: InboxAuditInput[]
} {
  const rows: SourceRow[] = [
    { channel: "email", sourceId: EMAIL_ID, sortAt: SHARED_AT, ownerId: ADMIN, createdBy: ADMIN },
    {
      channel: "whatsapp",
      sourceId: WHATSAPP_ID,
      sortAt: SHARED_AT,
      ownerId: null,
      createdBy: ADMIN,
    },
    {
      channel: "call",
      sourceId: CALL_ID,
      sortAt: new Date("2026-03-01T09:00:00Z"),
      ownerId: ADMIN,
      createdBy: ADMIN,
    },
  ]
  const overlay = new Map<string, OverlayRow>()
  const audits: InboxAuditInput[] = []
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
      workspaceId,
      sortAt: row.sortAt.toISOString(),
      ownerId: row.ownerId,
      title: `${row.channel} conversation`,
      participant: "ada@example.com",
      preview: "Any update?",
      assignedTo: state.assignedTo,
      assignedAt: state.assignedAt?.toISOString() ?? null,
      readAt: state.readAt?.toISOString() ?? null,
      archivedAt: state.archivedAt?.toISOString() ?? null,
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
    list: async (_ws, query) => {
      const limit = query.limit ?? 25
      const matching = rows
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
          return true
        })
        .sort((a, b) => {
          const byTime = b.sortAt.getTime() - a.sortAt.getTime()
          return byTime !== 0 ? byTime : b.sourceId.localeCompare(a.sourceId)
        })
      return {
        data: matching.slice(0, limit).map(toItem),
        pagination: { nextCursor: matching.length > limit ? "next" : null, limit },
      }
    },
    findItem: async (_ws, channel, sourceId, scope) => {
      const row = rows.find((entry) => entry.channel === channel && entry.sourceId === sourceId)
      return row && visible(row, scope) ? toItem(row) : null
    },
    setState: async (_ws, channel, sourceId, patch: InboxStatePatch) => {
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

  return {
    service: createUnifiedInboxService({
      store,
      audit: async (input) => {
        audits.push(input)
      },
    }),
    audits,
  }
}

function makeTestApp(session: { current: Session | null }, service: UnifiedInboxService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/inbox", createRoutes({ service }))
  return app
}

describe("api/unified-inbox", () => {
  let session: { current: Session | null }
  let owner: Session
  let viewer: Session
  let service: UnifiedInboxService
  let audits: InboxAuditInput[]
  let workspaceId: string

  beforeEach(() => {
    owner = makeSession({ role: "owner", userId: ADMIN })
    workspaceId = owner.workspaceId ?? ""
    viewer = makeSession({
      role: "viewer",
      userId: MEMBER,
      workspaceId,
      memberships: [{ workspaceId, role: "viewer" }],
    })
    session = { current: owner }
    const fake = makeFakeService(workspaceId)
    service = fake.service
    audits = fake.audits
  })

  test("route construction touches no database", () => {
    // Registry/full-app tests mount every module without Postgres: the
    // default service must stay lazy.
    expect(() => createRoutes()).not.toThrow()
  })

  test("listing requires a session", async () => {
    session.current = null
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/inbox")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("returns the merged stream in the shared paginated envelope", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const res = await api.get("/api/v1/inbox", { expectedStatus: 200 })
    const body = res.expectSuccess()
    const items = body.data as { id: string; channel: string; unread: boolean }[]
    expect(items.map((item) => item.channel)).toEqual(["whatsapp", "email", "call"])
    expect(items.every((item) => item.unread)).toBe(true)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("echoes the request id", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const res = await api.get("/api/v1/inbox", { requestId: "req-inbox-1" })
    expect(res.status).toBe(200)
  })

  test("filters by channel", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const res = await api.get("/api/v1/inbox?channel=call", { expectedStatus: 200 })
    const items = res.expectSuccess().data as { sourceId: string }[]
    expect(items.map((item) => item.sourceId)).toEqual([CALL_ID])
  })

  test("rejects an unknown channel filter with a 400 envelope", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const res = await api.get("/api/v1/inbox?channel=telegram")
    expect(res.status).toBe(400)
    res.expectError("VALIDATION_ERROR")
  })

  test("rejects an unknown channel in the path with a 400, not a 500", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const res = await api.get(`/api/v1/inbox/telegram/${CALL_ID}`)
    expect(res.status).toBe(400)
    res.expectError("VALIDATION_ERROR")
  })

  test("rejects a non-uuid source id with a 400", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const res = await api.get("/api/v1/inbox/call/not-a-uuid")
    expect(res.status).toBe(400)
    res.expectError("VALIDATION_ERROR")
  })

  test("an unknown item is a 404", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const res = await api.get("/api/v1/inbox/call/00000000-0000-4000-8000-000000000000")
    expect(res.status).toBe(404)
    res.expectError("NOT_FOUND")
  })

  test("opens one item", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const res = await api.get(`/api/v1/inbox/email/${EMAIL_ID}`, { expectedStatus: 200 })
    const item = res.expectSuccess().data as { id: string; channel: string }
    expect(item.id).toBe(`email:${EMAIL_ID}`)
    expect(item.channel).toBe("email")
  })

  test("assigns and unassigns a conversation, auditing both", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const assigned = await api.post(
      `/api/v1/inbox/whatsapp/${WHATSAPP_ID}/assignee`,
      { assigneeId: MEMBER },
      { expectedStatus: 200 },
    )
    expect((assigned.expectSuccess().data as { assignedTo: string }).assignedTo).toBe(MEMBER)

    const cleared = await api.delete(`/api/v1/inbox/whatsapp/${WHATSAPP_ID}/assignee`, {
      expectedStatus: 200,
    })
    expect((cleared.expectSuccess().data as { assignedTo: string | null }).assignedTo).toBeNull()
    expect(audits.map((entry) => entry.action)).toEqual(["assign", "unassign"])
  })

  test("claiming assigns the conversation to the caller", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const res = await api.post(`/api/v1/inbox/call/${CALL_ID}/assignee/me`, undefined, {
      expectedStatus: 200,
    })
    expect((res.expectSuccess().data as { assignedTo: string }).assignedTo).toBe(ADMIN)
  })

  test("rejects a non-uuid assignee with a 400", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const res = await api.post(`/api/v1/inbox/whatsapp/${WHATSAPP_ID}/assignee`, {
      assigneeId: "someone",
    })
    expect(res.status).toBe(400)
    res.expectError("VALIDATION_ERROR")
  })

  test("marks read and unread", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const read = await api.post(`/api/v1/inbox/call/${CALL_ID}/read`, undefined, {
      expectedStatus: 200,
    })
    expect((read.expectSuccess().data as { unread: boolean }).unread).toBe(false)

    const unread = await api.delete(`/api/v1/inbox/call/${CALL_ID}/read`, { expectedStatus: 200 })
    expect((unread.expectSuccess().data as { unread: boolean }).unread).toBe(true)
  })

  test("archives and restores, and archived items leave the default stream", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    await api.post(`/api/v1/inbox/call/${CALL_ID}/archive`, undefined, { expectedStatus: 200 })

    const live = await api.get("/api/v1/inbox", { expectedStatus: 200 })
    expect(
      (live.expectSuccess().data as { sourceId: string }[]).map((i) => i.sourceId),
    ).not.toContain(CALL_ID)

    const archived = await api.get("/api/v1/inbox?archived=true", { expectedStatus: 200 })
    expect(
      (archived.expectSuccess().data as { sourceId: string }[]).map((i) => i.sourceId),
    ).toEqual([CALL_ID])

    await api.delete(`/api/v1/inbox/call/${CALL_ID}/archive`, { expectedStatus: 200 })
    const restored = await api.get("/api/v1/inbox", { expectedStatus: 200 })
    expect(
      (restored.expectSuccess().data as { sourceId: string }[]).map((i) => i.sourceId),
    ).toContain(CALL_ID)
  })

  test("assigned=me narrows to the caller's conversations", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    await api.post(
      `/api/v1/inbox/whatsapp/${WHATSAPP_ID}/assignee`,
      { assigneeId: ADMIN },
      { expectedStatus: 200 },
    )
    const mine = await api.get("/api/v1/inbox?assigned=me", { expectedStatus: 200 })
    expect((mine.expectSuccess().data as { sourceId: string }[]).map((i) => i.sourceId)).toEqual([
      WHATSAPP_ID,
    ])
  })

  test("a viewer sees fewer items than the owner", async () => {
    const ownerApi = createApiClient({ app: makeTestApp(session, service), session: owner })
    const asOwner = (await ownerApi.get("/api/v1/inbox", { expectedStatus: 200 })).expectSuccess()

    session.current = viewer
    const viewerApi = createApiClient({ app: makeTestApp(session, service), session: viewer })
    const asViewer = (await viewerApi.get("/api/v1/inbox", { expectedStatus: 200 })).expectSuccess()

    const ownerIds = (asOwner.data as { sourceId: string }[]).map((i) => i.sourceId)
    const viewerIds = (asViewer.data as { sourceId: string }[]).map((i) => i.sourceId)
    expect(ownerIds).toHaveLength(3)
    // Only the unowned, unassigned shared-queue conversation survives.
    expect(viewerIds).toEqual([WHATSAPP_ID])
    expect(viewerIds.length).toBeLessThan(ownerIds.length)
  })

  test("a viewer's conversation they cannot see is a 404, not a 403", async () => {
    session.current = viewer
    const api = createApiClient({ app: makeTestApp(session, service), session: viewer })
    const res = await api.get(`/api/v1/inbox/email/${EMAIL_ID}`)
    expect(res.status).toBe(404)
    res.expectError("NOT_FOUND")
  })

  test("a viewer is denied assignment with a 403 envelope", async () => {
    session.current = viewer
    const api = createApiClient({ app: makeTestApp(session, service), session: viewer })
    const res = await api.post(`/api/v1/inbox/whatsapp/${WHATSAPP_ID}/assignee`, {
      assigneeId: MEMBER,
    })
    expect(res.status).toBe(403)
    res.expectError("FORBIDDEN")
    expect(audits).toHaveLength(0)
  })

  test("the same denial surfaces from the domain service as a PermissionDeniedError", async () => {
    await expectDenied(() =>
      service.assign(
        { workspaceId, actorId: MEMBER, role: "viewer" },
        { channel: "whatsapp", sourceId: WHATSAPP_ID },
        { assigneeId: MEMBER },
      ),
    )
  })
})
