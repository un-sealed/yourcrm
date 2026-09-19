import { createHash } from "node:crypto"
import { beforeEach, describe, expect, test } from "bun:test"
import { expectDenied, makeServiceContext } from "@yourcrm/testing"
import { createWorkspaceSettingsService, WorkspaceInviteConflictError } from "./service"
import type {
  SettingsAuditInput,
  WorkspaceInviteRecord,
  WorkspaceMemberRecord,
  WorkspaceSettingsRecord,
  WorkspaceSettingsServiceDeps,
} from "./types"

const WS = "11111111-1111-4111-8111-111111111111"
const OWNER_USER = "22222222-2222-4222-8222-222222222222"
const OWNER_2_USER = "22222222-2222-4222-8222-000000000002"
const ADMIN_USER = "33333333-3333-4333-8333-333333333333"
const MEMBER_USER = "44444444-4444-4444-8444-444444444444"

const NOW = new Date("2026-03-01T12:00:00.000Z")

type Fake = {
  deps: WorkspaceSettingsServiceDeps
  audits: SettingsAuditInput[]
  members: Map<string, WorkspaceMemberRecord>
  /** What the store actually persisted for each invite (hash, never raw). */
  tokenHashes: Map<string, string>
  issuedTokens: string[]
}

/**
 * In-memory store satisfying the real ports, so the service under test is
 * the production one. The token port mirrors `@yourcrm/auth` (a random
 * value + SHA-256) without importing it: `@yourcrm/crm` does not depend on
 * the auth package, which is exactly why tokens are injected.
 */
function makeFake(options: { secondOwner?: boolean } = {}): Fake {
  const audits: SettingsAuditInput[] = []
  const tokenHashes = new Map<string, string>()
  const issuedTokens: string[] = []
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
  const members = new Map<string, WorkspaceMemberRecord>()
  const seed = (
    membershipId: string,
    userId: string,
    role: string,
    active = true,
  ): WorkspaceMemberRecord => ({
    membershipId,
    userId,
    email: `${userId}@example.com`,
    name: null,
    role,
    active,
    joinedAt: NOW.toISOString(),
    lastLoginAt: null,
  })
  members.set("mem-owner", seed("mem-owner", OWNER_USER, "owner"))
  members.set("mem-admin", seed("mem-admin", ADMIN_USER, "admin"))
  members.set("mem-member", seed("mem-member", MEMBER_USER, "member"))
  if (options.secondOwner) {
    members.set("mem-owner-2", seed("mem-owner-2", OWNER_2_USER, "owner"))
  }
  const invites = new Map<string, WorkspaceInviteRecord>()
  let inviteSeq = 0
  let tokenSeq = 0

  const deps: WorkspaceSettingsServiceDeps = {
    now: () => NOW,
    tokens: {
      generate: () => {
        tokenSeq += 1
        const token = `raw-token-${tokenSeq}-${"a".repeat(32)}`
        issuedTokens.push(token)
        return token
      },
      hash: (token) => createHash("sha256").update(token, "utf8").digest("hex"),
    },
    audit: async (input) => {
      audits.push(input)
    },
    store: {
      getWorkspace: async (workspaceId) => (workspaceId === WS ? workspace : null),
      updateWorkspace: async (workspaceId, patch) => {
        if (workspaceId !== WS) return null
        workspace = { ...workspace, ...patch, updatedAt: NOW.toISOString() }
        return workspace
      },
      listMembers: async (_workspaceId, query) => ({
        data: [...members.values()].filter((m) =>
          query.status === undefined ? true : (query.status === "active") === m.active,
        ),
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
          query.state === "all" ? true : invite.acceptedAt === null && invite.revokedAt === null,
        ),
        pagination: { nextCursor: null, limit: query.limit ?? 25 },
      }),
      findInvite: async (_workspaceId, id) => invites.get(id) ?? null,
      findPendingInviteByEmail: async (_workspaceId, email) =>
        [...invites.values()].find(
          (invite) =>
            invite.email === email.toLowerCase() &&
            invite.acceptedAt === null &&
            invite.revokedAt === null,
        ) ?? null,
      createInvite: async (workspaceId, input) => {
        inviteSeq += 1
        const id = `invite-${inviteSeq}`
        const record: WorkspaceInviteRecord = {
          id,
          workspaceId,
          email: input.email,
          role: input.role,
          expiresAt: input.expiresAt.toISOString(),
          acceptedAt: null,
          revokedAt: null,
          invitedBy: input.invitedBy ?? null,
          createdAt: NOW.toISOString(),
        }
        invites.set(id, record)
        tokenHashes.set(id, input.tokenHash)
        return record
      },
      rotateInviteToken: async (_workspaceId, id, tokenHash, expiresAt) => {
        const current = invites.get(id)
        if (!current || current.revokedAt !== null || current.acceptedAt !== null) return null
        const next = { ...current, expiresAt: expiresAt.toISOString() }
        invites.set(id, next)
        tokenHashes.set(id, tokenHash)
        return next
      },
      revokeInvite: async (_workspaceId, id) => {
        const current = invites.get(id)
        if (!current || current.revokedAt !== null) return null
        const next = { ...current, revokedAt: NOW.toISOString() }
        invites.set(id, next)
        return next
      },
    },
  }
  return { deps, audits, members, tokenHashes, issuedTokens }
}

function ctxFor(role: string, actorId: string) {
  return makeServiceContext({ workspaceId: WS, actorId, role })
}

describe("settings/workspace-profile", () => {
  let fake: Fake

  beforeEach(() => {
    fake = makeFake()
  })

  test("an admin reads and updates the workspace profile", async () => {
    const service = createWorkspaceSettingsService(fake.deps)
    const ctx = ctxFor("admin", ADMIN_USER)
    expect((await service.getWorkspace(ctx)).name).toBe("Acme")
    const updated = await service.updateWorkspace(ctx, {
      name: "Acme Inc",
      timezone: "Europe/Berlin",
      currency: "eur",
      dateFormat: "DD/MM/YYYY",
      brandColor: "#0055ff",
    })
    expect(updated.name).toBe("Acme Inc")
    expect(updated.currency).toBe("EUR")
    expect(updated.timezone).toBe("Europe/Berlin")
  })

  test("the update writes one audit row with before AND after", async () => {
    const service = createWorkspaceSettingsService(fake.deps)
    await service.updateWorkspace(ctxFor("admin", ADMIN_USER), { name: "Acme Inc" })
    expect(fake.audits).toHaveLength(1)
    const row = fake.audits[0]
    expect(row?.action).toBe("settings.update")
    expect(row?.object).toBe("workspace_settings")
    expect(row?.recordId).toBe(WS)
    expect((row?.before as WorkspaceSettingsRecord).name).toBe("Acme")
    expect((row?.after as WorkspaceSettingsRecord).name).toBe("Acme Inc")
  })

  test("members and viewers cannot read or write settings", async () => {
    const service = createWorkspaceSettingsService(fake.deps)
    await expectDenied(() => service.getWorkspace(ctxFor("member", MEMBER_USER)))
    await expectDenied(() => service.updateWorkspace(ctxFor("member", MEMBER_USER), { name: "x" }))
    await expectDenied(() => service.updateWorkspace(ctxFor("viewer", MEMBER_USER), { name: "x" }))
    expect(fake.audits).toHaveLength(0)
  })

  test("invalid settings are rejected before anything is written", async () => {
    const service = createWorkspaceSettingsService(fake.deps)
    const ctx = ctxFor("owner", OWNER_USER)
    await expect(service.updateWorkspace(ctx, { currency: "euro" })).rejects.toThrow()
    await expect(service.updateWorkspace(ctx, { brandColor: "blue" })).rejects.toThrow()
    await expect(service.updateWorkspace(ctx, {})).rejects.toThrow()
    expect(fake.audits).toHaveLength(0)
  })
})

describe("settings/members/privilege-escalation", () => {
  let fake: Fake

  beforeEach(() => {
    fake = makeFake({ secondOwner: true })
  })

  test("ESCALATION 1: an admin cannot raise their own role", async () => {
    const service = createWorkspaceSettingsService(fake.deps)
    const denial = await expectDenied(() =>
      service.changeMemberRole(ctxFor("admin", ADMIN_USER), "mem-admin", { role: "owner" }),
    )
    expect(denial.message).toContain("your own role")
    expect(fake.members.get("mem-admin")?.role).toBe("admin")
    expect(fake.audits).toHaveLength(0)
  })

  test("ESCALATION 2: an admin cannot change an owner's role", async () => {
    const service = createWorkspaceSettingsService(fake.deps)
    const denial = await expectDenied(() =>
      service.changeMemberRole(ctxFor("admin", ADMIN_USER), "mem-owner", { role: "member" }),
    )
    expect(denial.message).toContain("only an owner")
    expect(fake.members.get("mem-owner")?.role).toBe("owner")
    expect(fake.audits).toHaveLength(0)
  })

  test("ESCALATION 3: the last owner cannot be demoted or deactivated", async () => {
    const single = makeFake()
    const service = createWorkspaceSettingsService(single.deps)
    const ctx = ctxFor("owner", OWNER_2_USER)
    const demote = await expectDenied(() =>
      service.changeMemberRole(ctx, "mem-owner", { role: "admin" }),
    )
    expect(demote.message).toContain("last owner")
    const deactivate = await expectDenied(() => service.setMemberActive(ctx, "mem-owner", false))
    expect(deactivate.message).toContain("last owner")
    expect(single.members.get("mem-owner")?.role).toBe("owner")
    expect(single.members.get("mem-owner")?.active).toBe(true)
    expect(single.audits).toHaveLength(0)
  })

  test("an admin cannot promote anybody to owner", async () => {
    const service = createWorkspaceSettingsService(fake.deps)
    await expectDenied(() =>
      service.changeMemberRole(ctxFor("admin", ADMIN_USER), "mem-member", { role: "owner" }),
    )
    expect(fake.members.get("mem-member")?.role).toBe("member")
  })

  test("a member cannot manage members at all", async () => {
    const service = createWorkspaceSettingsService(fake.deps)
    const ctx = ctxFor("member", MEMBER_USER)
    await expectDenied(() => service.listMembers(ctx, {}))
    await expectDenied(() => service.changeMemberRole(ctx, "mem-member", { role: "admin" }))
    await expectDenied(() => service.setMemberActive(ctx, "mem-admin", false))
    expect(fake.audits).toHaveLength(0)
  })

  test("a legitimate promotion succeeds and is audited", async () => {
    const service = createWorkspaceSettingsService(fake.deps)
    const updated = await service.changeMemberRole(ctxFor("owner", OWNER_USER), "mem-member", {
      role: "admin",
    })
    expect(updated.role).toBe("admin")
    expect(fake.audits).toHaveLength(1)
    expect(fake.audits[0]?.action).toBe("membership.role_changed")
    expect(fake.audits[0]?.before).toEqual({ role: "member" })
    expect(fake.audits[0]?.after).toEqual({ role: "admin" })
  })

  test("deactivation is a soft delete and is audited", async () => {
    const service = createWorkspaceSettingsService(fake.deps)
    const ctx = ctxFor("owner", OWNER_USER)
    const off = await service.setMemberActive(ctx, "mem-member", false)
    expect(off.active).toBe(false)
    const on = await service.setMemberActive(ctx, "mem-member", true)
    expect(on.active).toBe(true)
    expect(fake.audits.map((a) => a.action)).toEqual([
      "membership.deactivated",
      "membership.reactivated",
    ])
  })

  test("an unknown membership is a 404, not a silent no-op", async () => {
    const service = createWorkspaceSettingsService(fake.deps)
    await expect(
      service.changeMemberRole(ctxFor("owner", OWNER_USER), "nope", { role: "admin" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("settings/invites", () => {
  let fake: Fake

  beforeEach(() => {
    fake = makeFake()
  })

  test("an invite stores a HASH and returns the raw token exactly once", async () => {
    const service = createWorkspaceSettingsService(fake.deps)
    const { invite, token } = await service.invite(ctxFor("owner", OWNER_USER), {
      email: "New.Person@Example.com",
      role: "member",
    })
    expect(token).toBe(fake.issuedTokens[0] ?? "")
    const stored = fake.tokenHashes.get(invite.id)
    expect(stored).toBeDefined()
    expect(stored).not.toBe(token)
    expect(stored).toBe(createHash("sha256").update(token, "utf8").digest("hex"))
    expect(stored).toHaveLength(64)
    // The returned record has nowhere to put a token, raw or hashed.
    expect(Object.keys(invite)).not.toContain("tokenHash")
    expect(JSON.stringify(invite)).not.toContain(token)
    expect(invite.email).toBe("new.person@example.com")
  })

  test("an invite expires (default 7 days from the injected clock)", async () => {
    const service = createWorkspaceSettingsService(fake.deps)
    const { invite } = await service.invite(ctxFor("owner", OWNER_USER), {
      email: "a@example.com",
      role: "member",
    })
    expect(new Date(invite.expiresAt).getTime()).toBe(NOW.getTime() + 7 * 24 * 60 * 60 * 1000)
  })

  test("the audit row for an invite never carries the token", async () => {
    const service = createWorkspaceSettingsService(fake.deps)
    const { token } = await service.invite(ctxFor("owner", OWNER_USER), {
      email: "a@example.com",
      role: "member",
    })
    expect(fake.audits).toHaveLength(1)
    expect(fake.audits[0]?.action).toBe("invite.created")
    expect(JSON.stringify(fake.audits[0])).not.toContain(token)
  })

  test("resend rotates the hash so the previous link dies", async () => {
    const service = createWorkspaceSettingsService(fake.deps)
    const ctx = ctxFor("owner", OWNER_USER)
    const first = await service.invite(ctx, { email: "a@example.com", role: "member" })
    const firstHash = fake.tokenHashes.get(first.invite.id)
    const second = await service.resendInvite(ctx, first.invite.id)
    expect(second.token).not.toBe(first.token)
    expect(fake.tokenHashes.get(first.invite.id)).not.toBe(firstHash)
    expect(fake.audits.map((a) => a.action)).toEqual(["invite.created", "invite.resent"])
  })

  test("a duplicate pending invite is a conflict, not a second credential", async () => {
    const service = createWorkspaceSettingsService(fake.deps)
    const ctx = ctxFor("owner", OWNER_USER)
    await service.invite(ctx, { email: "a@example.com", role: "member" })
    await expect(
      service.invite(ctx, { email: "A@Example.com", role: "member" }),
    ).rejects.toBeInstanceOf(WorkspaceInviteConflictError)
  })

  test("revoking kills the invite and is audited", async () => {
    const service = createWorkspaceSettingsService(fake.deps)
    const ctx = ctxFor("owner", OWNER_USER)
    const { invite } = await service.invite(ctx, { email: "a@example.com", role: "member" })
    const revoked = await service.revokeInvite(ctx, invite.id)
    expect(revoked.revokedAt).not.toBeNull()
    const pending = await service.listInvites(ctx, {})
    expect(pending.data).toHaveLength(0)
    expect(fake.audits.map((a) => a.action)).toEqual(["invite.created", "invite.revoked"])
  })

  test("an admin cannot invite an owner, and a member cannot invite at all", async () => {
    const service = createWorkspaceSettingsService(fake.deps)
    await expectDenied(() =>
      service.invite(ctxFor("admin", ADMIN_USER), { email: "a@example.com", role: "owner" }),
    )
    await expectDenied(() =>
      service.invite(ctxFor("member", MEMBER_USER), { email: "a@example.com", role: "member" }),
    )
    expect(fake.audits).toHaveLength(0)
  })
})
