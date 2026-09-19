import { createHash } from "node:crypto"
import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import {
  createComplianceService,
  createWorkspaceSettingsService,
  createWorkspaceTeamService,
  type ComplianceService,
  type DataRequestRecord,
  type SettingsAuditInput,
  type WorkspaceAuditRecord,
  type WorkspaceInviteRecord,
  type WorkspaceMemberRecord,
  type WorkspaceSettingsRecord,
  type WorkspaceSettingsService,
  type WorkspaceTeamMemberRecord,
  type WorkspaceTeamRecord,
  type WorkspaceTeamService,
} from "@yourcrm/crm/src/settings"
import { createApiClient, makeSession } from "@yourcrm/testing"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes } from "./settings"

const WS = "11111111-1111-4111-8111-111111111111"
const OWNER_USER = "22222222-2222-4222-8222-222222222222"
const ADMIN_USER = "33333333-3333-4333-8333-333333333333"
const MEMBER_USER = "44444444-4444-4444-8444-444444444444"
const MEMBERSHIP = "55555555-5555-4555-8555-555555555555"
const SUBJECT = "77777777-7777-4777-8777-777777777777"
const NOW = new Date("2026-03-01T12:00:00.000Z")

type Fixture = {
  settings: WorkspaceSettingsService
  teams: WorkspaceTeamService
  compliance: ComplianceService
  audits: SettingsAuditInput[]
  members: Map<string, WorkspaceMemberRecord>
  tokenHashes: Map<string, string>
  deletedSubjects: string[]
}

/**
 * Hermetic API test: the route factory takes the three services, so the
 * tests inject the REAL domain services over in-memory stores. The
 * permission path, the escalation guards, the envelopes and the error
 * mapping are all exercised for real. No Postgres.
 */
function makeFixture(): Fixture {
  const audits: SettingsAuditInput[] = []
  const tokenHashes = new Map<string, string>()
  const deletedSubjects: string[] = []
  const audit = async (input: SettingsAuditInput) => {
    audits.push(input)
  }

  let workspace: WorkspaceSettingsRecord = {
    id: WS,
    name: "Acme",
    slug: "acme",
    timezone: "UTC",
    currency: "USD",
    dateFormat: "YYYY-MM-DD",
    logoUrl: null,
    brandColor: null,
    supportEmail: null,
    updatedAt: NOW.toISOString(),
  }

  const members = new Map<string, WorkspaceMemberRecord>([
    [
      "mem-owner",
      {
        membershipId: "mem-owner",
        userId: OWNER_USER,
        email: "owner@example.com",
        name: "Owner",
        role: "owner",
        active: true,
        joinedAt: NOW.toISOString(),
        lastLoginAt: null,
      },
    ],
    [
      "mem-owner-2",
      {
        membershipId: "mem-owner-2",
        userId: "22222222-2222-4222-8222-000000000002",
        email: "owner2@example.com",
        name: "Owner Two",
        role: "owner",
        active: true,
        joinedAt: NOW.toISOString(),
        lastLoginAt: null,
      },
    ],
    [
      "mem-admin",
      {
        membershipId: "mem-admin",
        userId: ADMIN_USER,
        email: "admin@example.com",
        name: "Admin",
        role: "admin",
        active: true,
        joinedAt: NOW.toISOString(),
        lastLoginAt: null,
      },
    ],
    [
      MEMBERSHIP,
      {
        membershipId: MEMBERSHIP,
        userId: MEMBER_USER,
        email: "member@example.com",
        name: "Member",
        role: "member",
        active: true,
        joinedAt: NOW.toISOString(),
        lastLoginAt: null,
      },
    ],
  ])

  const invites = new Map<string, WorkspaceInviteRecord>()
  let inviteSeq = 0
  let tokenSeq = 0

  const settings = createWorkspaceSettingsService({
    now: () => NOW,
    audit,
    tokens: {
      generate: () => {
        tokenSeq += 1
        return `raw-token-${tokenSeq}`
      },
      hash: (token) => createHash("sha256").update(token, "utf8").digest("hex"),
    },
    store: {
      getWorkspace: async () => workspace,
      updateWorkspace: async (_workspaceId, patch) => {
        workspace = { ...workspace, ...patch }
        return workspace
      },
      listMembers: async (_workspaceId, query) => ({
        data: [...members.values()],
        pagination: { nextCursor: null, limit: query.limit ?? 25 },
      }),
      findMember: async (_workspaceId, membershipId) => members.get(membershipId) ?? null,
      countActiveOwners: async () =>
        [...members.values()].filter((m) => m.role === "owner" && m.active).length,
      updateMemberRole: async (_workspaceId, membershipId, role) => {
        const current = members.get(membershipId)
        if (!current) return null
        const next = { ...current, role }
        members.set(membershipId, next)
        return next
      },
      setMemberActive: async (_workspaceId, membershipId, active) => {
        const current = members.get(membershipId)
        if (!current) return null
        const next = { ...current, active }
        members.set(membershipId, next)
        return next
      },
      listInvites: async (_workspaceId, query) => ({
        data: [...invites.values()].filter((invite) =>
          query.state === "all" ? true : invite.revokedAt === null && invite.acceptedAt === null,
        ),
        pagination: { nextCursor: null, limit: query.limit ?? 25 },
      }),
      findInvite: async (_workspaceId, id) => invites.get(id) ?? null,
      findPendingInviteByEmail: async (_workspaceId, email) =>
        [...invites.values()].find(
          (invite) =>
            invite.email === email.toLowerCase() &&
            invite.revokedAt === null &&
            invite.acceptedAt === null,
        ) ?? null,
      createInvite: async (workspaceId, input) => {
        inviteSeq += 1
        const record: WorkspaceInviteRecord = {
          id: `invite-${inviteSeq}`,
          workspaceId,
          email: input.email,
          role: input.role,
          expiresAt: input.expiresAt.toISOString(),
          acceptedAt: null,
          revokedAt: null,
          invitedBy: input.invitedBy ?? null,
          createdAt: NOW.toISOString(),
        }
        invites.set(record.id, record)
        tokenHashes.set(record.id, input.tokenHash)
        return record
      },
      rotateInviteToken: async (_workspaceId, id, tokenHash, expiresAt) => {
        const current = invites.get(id)
        if (!current) return null
        const next = { ...current, expiresAt: expiresAt.toISOString() }
        invites.set(id, next)
        tokenHashes.set(id, tokenHash)
        return next
      },
      revokeInvite: async (_workspaceId, id) => {
        const current = invites.get(id)
        if (!current) return null
        const next = { ...current, revokedAt: NOW.toISOString() }
        invites.set(id, next)
        return next
      },
    },
  })

  const teamRows = new Map<string, WorkspaceTeamRecord>()
  const teamEdges = new Map<string, WorkspaceTeamMemberRecord>()
  let teamSeq = 0
  const teams = createWorkspaceTeamService({
    audit,
    store: {
      list: async (_workspaceId, query) => ({
        data: [...teamRows.values()],
        pagination: { nextCursor: null, limit: query.limit ?? 25 },
      }),
      findById: async (_workspaceId, id) => teamRows.get(id) ?? null,
      create: async (workspaceId, input) => {
        teamSeq += 1
        const team: WorkspaceTeamRecord = {
          id: `team-${teamSeq}`,
          workspaceId,
          name: input.name,
          slug: input.slug,
          description: input.description ?? null,
          memberCount: 0,
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        }
        teamRows.set(team.id, team)
        return team
      },
      update: async (_workspaceId, id, input) => {
        const current = teamRows.get(id)
        if (!current) return null
        const next = { ...current, ...input }
        teamRows.set(id, next)
        return next
      },
      softDelete: async (_workspaceId, id) => {
        teamRows.delete(id)
      },
      listMembers: async (_workspaceId, teamId) =>
        [...teamEdges.values()].filter((edge) => edge.teamId === teamId),
      membershipExists: async (_workspaceId, membershipId) => members.has(membershipId),
      addMember: async (_workspaceId, teamId, membershipId, teamRole) => {
        const edge: WorkspaceTeamMemberRecord = {
          id: `${teamId}:${membershipId}`,
          teamId,
          membershipId,
          teamRole,
          userId: MEMBER_USER,
          email: "member@example.com",
          name: "Member",
          workspaceRole: "member",
          createdAt: NOW.toISOString(),
        }
        teamEdges.set(edge.id, edge)
        return edge
      },
      removeMember: async (_workspaceId, teamId, membershipId) =>
        teamEdges.delete(`${teamId}:${membershipId}`),
    },
  })

  const auditRows: WorkspaceAuditRecord[] = [
    {
      id: "aaaaaaa1-0000-4000-8000-000000000001",
      workspaceId: WS,
      actorId: OWNER_USER,
      action: "settings.update",
      object: "workspace_settings",
      recordId: WS,
      before: { name: "Acme" },
      after: { name: "Acme Inc" },
      correlationId: "req-1",
      source: "user",
      createdAt: NOW.toISOString(),
    },
  ]
  const requests = new Map<string, DataRequestRecord>()
  let requestSeq = 0
  const person: Record<string, unknown> = { id: SUBJECT, firstName: "Ada", deletedAt: null }
  const compliance = createComplianceService({
    audit,
    auditLog: {
      list: async (_workspaceId, query) => ({
        data: auditRows.filter((row) =>
          query.object === undefined ? true : row.object === query.object,
        ),
        pagination: { nextCursor: null, limit: query.limit ?? 25 },
      }),
      findById: async (_workspaceId, id) => auditRows.find((row) => row.id === id) ?? null,
    },
    requests: {
      list: async (_workspaceId, query) => ({
        data: [...requests.values()],
        pagination: { nextCursor: null, limit: query.limit ?? 25 },
      }),
      findById: async (_workspaceId, id) => requests.get(id) ?? null,
      create: async (workspaceId, input, actorId) => {
        requestSeq += 1
        const row: DataRequestRecord = {
          id: `data-request-${requestSeq}`,
          workspaceId,
          kind: input.kind,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          status: input.status ?? "pending",
          reason: input.reason ?? null,
          requestedBy: actorId ?? null,
          completedAt: null,
          completedBy: null,
          createdAt: NOW.toISOString(),
        }
        requests.set(row.id, row)
        return row
      },
      markStatus: async (_workspaceId, id, status) => {
        const current = requests.get(id)
        if (!current) return null
        const next = { ...current, status, completedAt: NOW.toISOString() }
        requests.set(id, next)
        return next
      },
    },
    subjects: {
      load: async (_workspaceId, subjectId) =>
        subjectId === SUBJECT && person.deletedAt === null ? { ...person } : null,
      softDelete: async (_workspaceId, subjectId) => {
        if (subjectId !== SUBJECT) return false
        person.deletedAt = NOW.toISOString()
        deletedSubjects.push(subjectId)
        return true
      },
    },
  })

  return { settings, teams, compliance, audits, members, tokenHashes, deletedSubjects }
}

function makeTestApp(session: { current: Session | null }, fixture: Fixture) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route(
    "/api/v1/settings",
    createRoutes({
      settings: fixture.settings,
      teams: fixture.teams,
      compliance: fixture.compliance,
    }),
  )
  return app
}

function sessionFor(role: "owner" | "admin" | "member" | "viewer", userId: string): Session {
  return makeSession({ role, workspaceId: WS, userId })
}

describe("api/settings/workspace", () => {
  let fixture: Fixture
  let session: { current: Session | null }

  beforeEach(() => {
    fixture = makeFixture()
    session = { current: sessionFor("owner", OWNER_USER) }
  })

  test("unauthenticated requests get UNAUTHORIZED", async () => {
    session.current = null
    const api = createApiClient({ app: makeTestApp(session, fixture) })
    const res = await api.get("/api/v1/settings/workspace")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("an owner reads and patches the workspace profile", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture) })
    const read = await api.get("/api/v1/settings/workspace")
    expect(read.status).toBe(200)
    expect((read.expectSuccess().data as WorkspaceSettingsRecord).name).toBe("Acme")
    const patched = await api.patch("/api/v1/settings/workspace", {
      name: "Acme Inc",
      currency: "eur",
      brandColor: "#112233",
    })
    expect(patched.status).toBe(200)
    const data = patched.expectSuccess().data as WorkspaceSettingsRecord
    expect(data.currency).toBe("EUR")
    expect(fixture.audits.map((a) => a.action)).toEqual(["settings.update"])
  })

  test("an invalid patch is a 400 with the shared envelope", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture) })
    const res = await api.patch("/api/v1/settings/workspace", { brandColor: "blue" })
    expect(res.status).toBe(400)
    res.expectError("VALIDATION_ERROR")
    expect(fixture.audits).toHaveLength(0)
  })

  test("a member gets 403 on every settings mutation", async () => {
    session.current = sessionFor("member", MEMBER_USER)
    const api = createApiClient({ app: makeTestApp(session, fixture) })
    for (const res of [
      await api.get("/api/v1/settings/workspace"),
      await api.patch("/api/v1/settings/workspace", { name: "x" }),
      await api.get("/api/v1/settings/members"),
      await api.get("/api/v1/settings/teams"),
      await api.get("/api/v1/settings/audit"),
      await api.get("/api/v1/settings/data-requests"),
    ]) {
      expect(res.status).toBe(403)
      res.expectError("FORBIDDEN")
    }
    expect(fixture.audits).toHaveLength(0)
  })
})

describe("api/settings/members — privilege escalation is blocked over HTTP", () => {
  let fixture: Fixture
  let session: { current: Session | null }

  beforeEach(() => {
    fixture = makeFixture()
    session = { current: sessionFor("admin", ADMIN_USER) }
  })

  test("ESCALATION 1: an admin cannot raise their own role", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture) })
    const res = await api.patch("/api/v1/settings/members/mem-admin/role", { role: "owner" })
    expect(res.status).toBe(403)
    expect(res.expectError("FORBIDDEN").error.message).toContain("your own role")
    expect(fixture.members.get("mem-admin")?.role).toBe("admin")
    expect(fixture.audits).toHaveLength(0)
  })

  test("ESCALATION 2: an admin cannot change an owner's role or deactivate one", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture) })
    const demote = await api.patch("/api/v1/settings/members/mem-owner/role", { role: "member" })
    expect(demote.status).toBe(403)
    expect(demote.expectError("FORBIDDEN").error.message).toContain("only an owner")
    const off = await api.post("/api/v1/settings/members/mem-owner/deactivate")
    expect(off.status).toBe(403)
    expect(fixture.members.get("mem-owner")).toMatchObject({ role: "owner", active: true })
    expect(fixture.audits).toHaveLength(0)
  })

  test("ESCALATION 3: the last owner cannot be demoted or deactivated", async () => {
    session.current = sessionFor("owner", OWNER_USER)
    const api = createApiClient({ app: makeTestApp(session, fixture) })
    // Leave exactly one active owner: the caller demotes the *other* owner.
    const ok = await api.patch("/api/v1/settings/members/mem-owner-2/role", { role: "admin" })
    expect(ok.status).toBe(200)
    // Now mem-owner is the last one, and the caller is somebody else.
    session.current = sessionFor("owner", "99999999-9999-4999-8999-999999999999")
    const demote = await api.patch("/api/v1/settings/members/mem-owner/role", { role: "admin" })
    expect(demote.status).toBe(403)
    expect(demote.expectError("FORBIDDEN").error.message).toContain("last owner")
    const off = await api.post("/api/v1/settings/members/mem-owner/deactivate")
    expect(off.status).toBe(403)
    expect(off.expectError("FORBIDDEN").error.message).toContain("last owner")
    expect(fixture.members.get("mem-owner")).toMatchObject({ role: "owner", active: true })
  })

  test("a legitimate role change and deactivation return the member envelope", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture) })
    const promoted = await api.patch(`/api/v1/settings/members/${MEMBERSHIP}/role`, {
      role: "admin",
    })
    expect(promoted.status).toBe(200)
    expect((promoted.expectSuccess().data as WorkspaceMemberRecord).role).toBe("admin")
    const off = await api.post(`/api/v1/settings/members/${MEMBERSHIP}/deactivate`)
    expect((off.expectSuccess().data as WorkspaceMemberRecord).active).toBe(false)
    const on = await api.post(`/api/v1/settings/members/${MEMBERSHIP}/reactivate`)
    expect((on.expectSuccess().data as WorkspaceMemberRecord).active).toBe(true)
    expect(fixture.audits.map((a) => a.action)).toEqual([
      "membership.role_changed",
      "membership.deactivated",
      "membership.reactivated",
    ])
  })

  test("an unknown role value is a 400, not a 500", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture) })
    const res = await api.patch(`/api/v1/settings/members/${MEMBERSHIP}/role`, { role: "root" })
    expect(res.status).toBe(400)
    res.expectError("VALIDATION_ERROR")
  })

  test("the member list uses the pagination envelope", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture) })
    const res = await api.get("/api/v1/settings/members?limit=10")
    const body = res.expectSuccess()
    expect(body.pagination).toEqual({ nextCursor: null, limit: 10 })
    expect((body.data as WorkspaceMemberRecord[]).length).toBeGreaterThan(0)
  })
})

describe("api/settings/invites", () => {
  let fixture: Fixture
  let session: { current: Session | null }

  beforeEach(() => {
    fixture = makeFixture()
    session = { current: sessionFor("owner", OWNER_USER) }
  })

  test("creating an invite returns the raw token once and stores only a hash", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture) })
    const created = await api.post("/api/v1/settings/invites", {
      email: "New@Example.com",
      role: "member",
    })
    expect(created.status).toBe(201)
    const data = created.expectSuccess().data as WorkspaceInviteRecord & { token: string }
    expect(data.token).toBe("raw-token-1")
    expect(fixture.tokenHashes.get(data.id)).toBe(
      createHash("sha256").update("raw-token-1", "utf8").digest("hex"),
    )
    // The token is nowhere in the listing — it exists only in that response.
    const listed = await api.get("/api/v1/settings/invites")
    expect(JSON.stringify(listed.body)).not.toContain("raw-token-1")
    expect(JSON.stringify(listed.body)).not.toContain("tokenHash")
  })

  test("resending rotates the token; revoking removes it from the pending list", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture) })
    const created = await api.post("/api/v1/settings/invites", { email: "a@example.com" })
    const invite = created.expectSuccess().data as WorkspaceInviteRecord & { token: string }
    const resent = await api.post(`/api/v1/settings/invites/${invite.id}/resend`)
    const resentData = resent.expectSuccess().data as { token: string }
    expect(resentData.token).not.toBe(invite.token)
    const revoked = await api.delete(`/api/v1/settings/invites/${invite.id}`)
    expect(revoked.status).toBe(200)
    const pending = await api.get("/api/v1/settings/invites")
    expect(pending.expectSuccess().data).toHaveLength(0)
  })

  test("an admin inviting an owner is 403; a duplicate pending invite is 409", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture) })
    await api.post("/api/v1/settings/invites", { email: "dup@example.com" })
    const duplicate = await api.post("/api/v1/settings/invites", { email: "dup@example.com" })
    expect(duplicate.status).toBe(409)
    duplicate.expectError("CONFLICT")

    session.current = sessionFor("admin", ADMIN_USER)
    const escalating = await api.post("/api/v1/settings/invites", {
      email: "new-owner@example.com",
      role: "owner",
    })
    expect(escalating.status).toBe(403)
    escalating.expectError("FORBIDDEN")
  })

  test("a malformed email never reaches the service", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture) })
    const res = await api.post("/api/v1/settings/invites", { email: "not-an-email" })
    expect(res.status).toBe(400)
    res.expectError("VALIDATION_ERROR")
    expect(fixture.audits).toHaveLength(0)
  })
})

describe("api/settings/teams", () => {
  let fixture: Fixture
  let session: { current: Session | null }

  beforeEach(() => {
    fixture = makeFixture()
    session = { current: sessionFor("admin", ADMIN_USER) }
  })

  test("teams CRUD plus membership edges", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture) })
    const created = await api.post("/api/v1/settings/teams", { name: "Field Sales" })
    expect(created.status).toBe(201)
    const team = created.expectSuccess().data as WorkspaceTeamRecord
    expect(team.slug).toBe("field-sales")

    const added = await api.post(`/api/v1/settings/teams/${team.id}/members`, {
      membershipId: MEMBERSHIP,
      teamRole: "lead",
    })
    expect(added.status).toBe(201)

    const detail = await api.get(`/api/v1/settings/teams/${team.id}`)
    const body = detail.expectSuccess().data as { members: unknown[] }
    expect(body.members).toHaveLength(1)

    const renamed = await api.patch(`/api/v1/settings/teams/${team.id}`, { name: "Field Sales EU" })
    expect((renamed.expectSuccess().data as WorkspaceTeamRecord).name).toBe("Field Sales EU")

    const removed = await api.delete(`/api/v1/settings/teams/${team.id}/members/${MEMBERSHIP}`)
    expect(removed.expectSuccess().data).toEqual({ removed: true })

    const deleted = await api.delete(`/api/v1/settings/teams/${team.id}`)
    expect(deleted.expectSuccess().data).toEqual({ deleted: true })
    expect((await api.get(`/api/v1/settings/teams/${team.id}`)).status).toBe(404)
  })

  test("a membership outside the workspace cannot be added to a team", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture) })
    const team = (await api.post("/api/v1/settings/teams", { name: "Support" })).expectSuccess()
      .data as WorkspaceTeamRecord
    const res = await api.post(`/api/v1/settings/teams/${team.id}/members`, {
      membershipId: "88888888-8888-4888-8888-888888888888",
    })
    expect(res.status).toBe(400)
    res.expectError("VALIDATION_ERROR")
  })

  test("a viewer cannot create a team", async () => {
    session.current = sessionFor("viewer", MEMBER_USER)
    const api = createApiClient({ app: makeTestApp(session, fixture) })
    const res = await api.post("/api/v1/settings/teams", { name: "Nope" })
    expect(res.status).toBe(403)
    res.expectError("FORBIDDEN")
  })
})

describe("api/settings/audit — append-only", () => {
  let fixture: Fixture
  let session: { current: Session | null }

  beforeEach(() => {
    fixture = makeFixture()
    session = { current: sessionFor("owner", OWNER_USER) }
  })

  test("the audit log is readable and filterable", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture) })
    const res = await api.get("/api/v1/settings/audit?object=workspace_settings&limit=50")
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 50 })
    const one = await api.get("/api/v1/settings/audit/aaaaaaa1-0000-4000-8000-000000000001")
    expect((one.expectSuccess().data as WorkspaceAuditRecord).action).toBe("settings.update")
    expect(
      (await api.get("/api/v1/settings/audit/aaaaaaa1-0000-4000-8000-000000000009")).status,
    ).toBe(404)
  })

  test("APPEND-ONLY: the module registers no write route on an audit path", () => {
    const routes = createRoutes({
      settings: fixture.settings,
      teams: fixture.teams,
      compliance: fixture.compliance,
    }).routes
    const auditRoutes = routes.filter((route) => route.path.includes("/audit"))
    expect(auditRoutes.length).toBeGreaterThan(0)
    for (const route of auditRoutes) {
      expect([route.path, route.method]).toEqual([route.path, "GET"])
    }
  })

  test("APPEND-ONLY: writes to an audit path are not routed", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture) })
    const id = "aaaaaaa1-0000-4000-8000-000000000001"
    for (const call of [
      api.post("/api/v1/settings/audit", { action: "forged" }),
      api.patch(`/api/v1/settings/audit/${id}`, { action: "forged" }),
      api.put(`/api/v1/settings/audit/${id}`, { action: "forged" }),
      api.delete(`/api/v1/settings/audit/${id}`),
    ]) {
      const res = await call
      expect(res.status).toBe(404)
    }
    // Nothing was written, and the row is untouched.
    expect(fixture.audits).toHaveLength(0)
    const after = await api.get(`/api/v1/settings/audit/${id}`)
    expect((after.expectSuccess().data as WorkspaceAuditRecord).action).toBe("settings.update")
  })
})

describe("api/settings/data-requests", () => {
  let fixture: Fixture
  let session: { current: Session | null }

  beforeEach(() => {
    fixture = makeFixture()
    session = { current: sessionFor("owner", OWNER_USER) }
  })

  test("an export request is recorded, then assembled on demand", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture) })
    const created = await api.post("/api/v1/settings/data-requests", {
      kind: "export",
      subjectId: SUBJECT,
    })
    expect(created.status).toBe(201)
    const request = created.expectSuccess().data as DataRequestRecord
    expect(request.status).toBe("pending")
    // The stored request carries ids only — no subject data at rest.
    expect(JSON.stringify(request)).not.toContain("Ada")

    const exported = await api.post(`/api/v1/settings/data-requests/${request.id}/export`)
    const payload = exported.expectSuccess().data as { record: { firstName: string } }
    expect(payload.record.firstName).toBe("Ada")
    expect(fixture.deletedSubjects).toHaveLength(0)
  })

  test("a deletion request soft-deletes the subject and is never a hard delete", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture) })
    const res = await api.post("/api/v1/settings/data-requests", {
      kind: "deletion",
      subjectId: SUBJECT,
      reason: "erasure request",
    })
    expect(res.status).toBe(201)
    expect((res.expectSuccess().data as DataRequestRecord).status).toBe("soft_deleted")
    expect(fixture.deletedSubjects).toEqual([SUBJECT])
    const listed = await api.get("/api/v1/settings/data-requests")
    expect(listed.expectSuccess().data).toHaveLength(1)
    expect(fixture.audits.map((a) => a.action)).toEqual([
      "data_request.deletion",
      "data_request.soft_deleted",
    ])
  })

  test("an unknown subject is a 404 and a bad kind a 400", async () => {
    const api = createApiClient({ app: makeTestApp(session, fixture) })
    const missing = await api.post("/api/v1/settings/data-requests", {
      kind: "export",
      subjectId: "88888888-8888-4888-8888-888888888888",
    })
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")
    const bad = await api.post("/api/v1/settings/data-requests", {
      kind: "purge",
      subjectId: SUBJECT,
    })
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")
  })
})
