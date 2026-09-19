import { beforeEach, describe, expect, test } from "bun:test"
import { expectDenied, makeServiceContext } from "@yourcrm/testing"
import { createWorkspaceTeamService, WorkspaceTeamMembershipError } from "./teams-service"
import type {
  SettingsAuditInput,
  WorkspaceTeamMemberRecord,
  WorkspaceTeamRecord,
  WorkspaceTeamServiceDeps,
} from "./types"

const WS = "11111111-1111-4111-8111-111111111111"
const ADMIN_USER = "33333333-3333-4333-8333-333333333333"
const MEMBER_USER = "44444444-4444-4444-8444-444444444444"
const MEMBERSHIP = "55555555-5555-4555-8555-555555555555"
const FOREIGN_MEMBERSHIP = "66666666-6666-4666-8666-666666666666"

const NOW = "2026-03-01T12:00:00.000Z"

type Fake = { deps: WorkspaceTeamServiceDeps; audits: SettingsAuditInput[] }

function makeFake(): Fake {
  const audits: SettingsAuditInput[] = []
  const teams = new Map<string, WorkspaceTeamRecord>()
  const edges = new Map<string, WorkspaceTeamMemberRecord>()
  let seq = 0

  const deps: WorkspaceTeamServiceDeps = {
    audit: async (input) => {
      audits.push(input)
    },
    store: {
      list: async (_workspaceId, query) => ({
        data: [...teams.values()],
        pagination: { nextCursor: null, limit: query.limit ?? 25 },
      }),
      findById: async (_workspaceId, id) => teams.get(id) ?? null,
      create: async (workspaceId, input) => {
        seq += 1
        const team: WorkspaceTeamRecord = {
          id: `team-${seq}`,
          workspaceId,
          name: input.name,
          slug: input.slug,
          description: input.description ?? null,
          memberCount: 0,
          createdAt: NOW,
          updatedAt: NOW,
        }
        teams.set(team.id, team)
        return team
      },
      update: async (_workspaceId, id, input) => {
        const current = teams.get(id)
        if (!current) return null
        const next = { ...current, ...input, updatedAt: NOW }
        teams.set(id, next)
        return next
      },
      softDelete: async (_workspaceId, id) => {
        teams.delete(id)
        for (const [key, edge] of edges) if (edge.teamId === id) edges.delete(key)
      },
      listMembers: async (_workspaceId, teamId) =>
        [...edges.values()].filter((edge) => edge.teamId === teamId),
      membershipExists: async (_workspaceId, membershipId) => membershipId === MEMBERSHIP,
      addMember: async (_workspaceId, teamId, membershipId, teamRole) => {
        const key = `${teamId}:${membershipId}`
        const edge: WorkspaceTeamMemberRecord = {
          id: key,
          teamId,
          membershipId,
          teamRole,
          userId: MEMBER_USER,
          email: "member@example.com",
          name: null,
          workspaceRole: "member",
          createdAt: NOW,
        }
        edges.set(key, edge)
        return edge
      },
      removeMember: async (_workspaceId, teamId, membershipId) =>
        edges.delete(`${teamId}:${membershipId}`),
    },
  }
  return { deps, audits }
}

function ctxFor(role: string, actorId = ADMIN_USER) {
  return makeServiceContext({ workspaceId: WS, actorId, role })
}

describe("settings/teams", () => {
  let fake: Fake

  beforeEach(() => {
    fake = makeFake()
  })

  test("an admin creates a team; the slug is derived from the name", async () => {
    const service = createWorkspaceTeamService(fake.deps)
    const team = await service.create(ctxFor("admin"), { name: "  Field  Sales EMEA " })
    expect(team.name).toBe("Field  Sales EMEA")
    expect(team.slug).toBe("field-sales-emea")
    expect(fake.audits[0]?.action).toBe("team.created")
  })

  test("members and viewers cannot touch teams", async () => {
    const service = createWorkspaceTeamService(fake.deps)
    const ctx = ctxFor("member", MEMBER_USER)
    await expectDenied(() => service.list(ctx, {}))
    await expectDenied(() => service.create(ctx, { name: "Shadow team" }))
    await expectDenied(() => service.update(ctx, "team-1", { name: "x" }))
    await expectDenied(() => service.softDelete(ctx, "team-1"))
    await expectDenied(() => service.addMember(ctx, "team-1", { membershipId: MEMBERSHIP }))
    await expectDenied(() => service.removeMember(ctx, "team-1", MEMBERSHIP))
    expect(fake.audits).toHaveLength(0)
  })

  test("adding and removing a member audits both sides", async () => {
    const service = createWorkspaceTeamService(fake.deps)
    const ctx = ctxFor("admin")
    const team = await service.create(ctx, { name: "Support" })
    const edge = await service.addMember(ctx, team.id, {
      membershipId: MEMBERSHIP,
      teamRole: "lead",
    })
    expect(edge.teamRole).toBe("lead")
    const detail = await service.get(ctx, team.id)
    expect(detail.members).toHaveLength(1)
    expect(await service.removeMember(ctx, team.id, MEMBERSHIP)).toEqual({ removed: true })
    expect(fake.audits.map((a) => a.action)).toEqual([
      "team.created",
      "team.member_added",
      "team.member_removed",
    ])
  })

  test("a membership from another workspace cannot be added", async () => {
    const service = createWorkspaceTeamService(fake.deps)
    const ctx = ctxFor("admin")
    const team = await service.create(ctx, { name: "Support" })
    await expect(
      service.addMember(ctx, team.id, { membershipId: FOREIGN_MEMBERSHIP }),
    ).rejects.toBeInstanceOf(WorkspaceTeamMembershipError)
  })

  test("a team grants no permission rank — team_role is not a workspace role", async () => {
    const service = createWorkspaceTeamService(fake.deps)
    const ctx = ctxFor("admin")
    const team = await service.create(ctx, { name: "Leads" })
    const edge = await service.addMember(ctx, team.id, {
      membershipId: MEMBERSHIP,
      teamRole: "lead",
    })
    // Being a team "lead" leaves the workspace role untouched...
    expect(edge.workspaceRole).toBe("member")
    // ...so that member still cannot administer anything.
    await expectDenied(() => service.list(ctxFor("member", MEMBER_USER), {}))
  })

  test("unknown teams are 404s and deleting soft-deletes", async () => {
    const service = createWorkspaceTeamService(fake.deps)
    const ctx = ctxFor("owner")
    await expect(service.get(ctx, "team-nope")).rejects.toMatchObject({ code: "NOT_FOUND" })
    const team = await service.create(ctx, { name: "Temp" })
    await service.softDelete(ctx, team.id)
    await expect(service.get(ctx, team.id)).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(fake.audits.at(-1)?.action).toBe("team.deleted")
  })

  test("an invalid team patch is rejected", async () => {
    const service = createWorkspaceTeamService(fake.deps)
    const ctx = ctxFor("admin")
    const team = await service.create(ctx, { name: "Temp" })
    await expect(service.update(ctx, team.id, {})).rejects.toThrow()
    await expect(service.update(ctx, team.id, { slug: "Not A Slug" })).rejects.toThrow()
  })
})
