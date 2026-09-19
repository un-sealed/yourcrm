import { describe, expect, test } from "bun:test"
import {
  checkInviteUsable,
  checkWorkspaceInviteRole,
  checkWorkspaceMemberActivation,
  checkWorkspaceRoleChange,
  isWorkspaceMemberRoleName,
  workspaceRoleRank,
  WORKSPACE_MEMBER_ROLES,
} from "./roles"

/**
 * The privilege-escalation truth table. These are the rules an attacker
 * attacks, so each one is asserted on its own, in both directions (the
 * denial AND the legitimate case it must not block).
 */

const ADMIN = "11111111-1111-4111-8111-111111111111"
const OWNER = "22222222-2222-4222-8222-222222222222"
const MEMBER = "33333333-3333-4333-8333-333333333333"

function target(
  overrides: Partial<{ membershipId: string; userId: string; role: string; active: boolean }> = {},
) {
  return {
    membershipId: "mem-1",
    userId: MEMBER,
    role: "member",
    active: true,
    ...overrides,
  }
}

describe("settings/roles/rank", () => {
  test("ranks mirror the permissions policy ordering", () => {
    expect(workspaceRoleRank("owner")).toBeGreaterThan(workspaceRoleRank("admin"))
    expect(workspaceRoleRank("admin")).toBeGreaterThan(workspaceRoleRank("member"))
    expect(workspaceRoleRank("member")).toBeGreaterThan(workspaceRoleRank("viewer"))
  })

  test("unknown and missing roles rank lowest (fail closed)", () => {
    expect(workspaceRoleRank("superuser")).toBe(0)
    expect(workspaceRoleRank(null)).toBe(0)
    expect(workspaceRoleRank(undefined)).toBe(0)
    expect(isWorkspaceMemberRoleName("superuser")).toBe(false)
    for (const role of WORKSPACE_MEMBER_ROLES) expect(isWorkspaceMemberRoleName(role)).toBe(true)
  })
})

describe("settings/roles/self-escalation", () => {
  test("ESCALATION 1: an admin cannot raise their own role to owner", () => {
    const verdict = checkWorkspaceRoleChange({
      actorId: ADMIN,
      actorRole: "admin",
      target: target({ membershipId: "mem-admin", userId: ADMIN, role: "admin" }),
      nextRole: "owner",
      activeOwnerCount: 1,
    })
    expect(verdict.allowed).toBe(false)
    expect(verdict.allowed === false && verdict.reason).toContain("your own role")
  })

  test("a member cannot quietly raise themselves to admin either", () => {
    const verdict = checkWorkspaceRoleChange({
      actorId: MEMBER,
      actorRole: "member",
      target: target({ userId: MEMBER, role: "member" }),
      nextRole: "admin",
      activeOwnerCount: 1,
    })
    expect(verdict.allowed).toBe(false)
  })

  test("even an owner cannot change their own role", () => {
    const verdict = checkWorkspaceRoleChange({
      actorId: OWNER,
      actorRole: "owner",
      target: target({ userId: OWNER, role: "owner" }),
      nextRole: "admin",
      activeOwnerCount: 2,
    })
    expect(verdict.allowed).toBe(false)
  })
})

describe("settings/roles/owner-protection", () => {
  test("ESCALATION 2: an admin cannot change an owner's role", () => {
    const verdict = checkWorkspaceRoleChange({
      actorId: ADMIN,
      actorRole: "admin",
      target: target({ membershipId: "mem-owner", userId: OWNER, role: "owner" }),
      nextRole: "member",
      activeOwnerCount: 3,
    })
    expect(verdict.allowed).toBe(false)
    expect(verdict.allowed === false && verdict.reason).toContain("only an owner")
  })

  test("an owner may demote another owner while others remain", () => {
    const verdict = checkWorkspaceRoleChange({
      actorId: OWNER,
      actorRole: "owner",
      target: target({ membershipId: "mem-owner-2", userId: "other-owner", role: "owner" }),
      nextRole: "admin",
      activeOwnerCount: 2,
    })
    expect(verdict.allowed).toBe(true)
  })

  test("an admin cannot mint a new owner (granting above own rank)", () => {
    const verdict = checkWorkspaceRoleChange({
      actorId: ADMIN,
      actorRole: "admin",
      target: target(),
      nextRole: "owner",
      activeOwnerCount: 2,
    })
    expect(verdict.allowed).toBe(false)
    expect(verdict.allowed === false && verdict.reason).toContain("outranks")
  })

  test("an admin may still promote a member to admin", () => {
    expect(
      checkWorkspaceRoleChange({
        actorId: ADMIN,
        actorRole: "admin",
        target: target(),
        nextRole: "admin",
        activeOwnerCount: 1,
      }).allowed,
    ).toBe(true)
  })
})

describe("settings/roles/last-owner", () => {
  test("ESCALATION 3: the last owner cannot be demoted, even by an owner", () => {
    const verdict = checkWorkspaceRoleChange({
      actorId: OWNER,
      actorRole: "owner",
      target: target({ membershipId: "mem-last", userId: "last-owner", role: "owner" }),
      nextRole: "admin",
      activeOwnerCount: 1,
    })
    expect(verdict.allowed).toBe(false)
    expect(verdict.allowed === false && verdict.reason).toContain("last owner")
  })

  test("the last owner cannot be deactivated", () => {
    const verdict = checkWorkspaceMemberActivation({
      actorId: OWNER,
      actorRole: "owner",
      target: target({ membershipId: "mem-last", userId: "last-owner", role: "owner" }),
      active: false,
      activeOwnerCount: 1,
    })
    expect(verdict.allowed).toBe(false)
    expect(verdict.allowed === false && verdict.reason).toContain("last owner")
  })

  test("an owner may be deactivated while another owner remains", () => {
    expect(
      checkWorkspaceMemberActivation({
        actorId: OWNER,
        actorRole: "owner",
        target: target({ membershipId: "mem-owner-2", userId: "other-owner", role: "owner" }),
        active: false,
        activeOwnerCount: 2,
      }).allowed,
    ).toBe(true)
  })
})

describe("settings/roles/activation", () => {
  test("an admin cannot deactivate or reactivate an owner", () => {
    for (const active of [true, false]) {
      const verdict = checkWorkspaceMemberActivation({
        actorId: ADMIN,
        actorRole: "admin",
        target: target({ userId: OWNER, role: "owner", active: !active }),
        active,
        activeOwnerCount: 3,
      })
      expect(verdict.allowed).toBe(false)
    }
  })

  test("nobody deactivates themselves", () => {
    expect(
      checkWorkspaceMemberActivation({
        actorId: ADMIN,
        actorRole: "admin",
        target: target({ userId: ADMIN, role: "admin" }),
        active: false,
        activeOwnerCount: 2,
      }).allowed,
    ).toBe(false)
  })

  test("a no-op activation is rejected rather than audited as a change", () => {
    expect(
      checkWorkspaceMemberActivation({
        actorId: ADMIN,
        actorRole: "admin",
        target: target({ active: true }),
        active: true,
        activeOwnerCount: 2,
      }).allowed,
    ).toBe(false)
    expect(
      checkWorkspaceRoleChange({
        actorId: ADMIN,
        actorRole: "admin",
        target: target({ role: "member" }),
        nextRole: "member",
        activeOwnerCount: 2,
      }).allowed,
    ).toBe(false)
  })

  test("an unknown target role is refused, not coerced", () => {
    expect(
      checkWorkspaceRoleChange({
        actorId: ADMIN,
        actorRole: "admin",
        target: target(),
        nextRole: "superuser",
        activeOwnerCount: 2,
      }).allowed,
    ).toBe(false)
  })
})

describe("settings/roles/invites", () => {
  test("an admin cannot invite an owner", () => {
    expect(
      checkWorkspaceInviteRole({ actorId: ADMIN, actorRole: "admin", role: "owner" }).allowed,
    ).toBe(false)
  })

  test("an owner can invite an owner, an admin can invite an admin", () => {
    expect(
      checkWorkspaceInviteRole({ actorId: OWNER, actorRole: "owner", role: "owner" }).allowed,
    ).toBe(true)
    expect(
      checkWorkspaceInviteRole({ actorId: ADMIN, actorRole: "admin", role: "admin" }).allowed,
    ).toBe(true)
  })

  test("an unknown invite role is refused", () => {
    expect(
      checkWorkspaceInviteRole({ actorId: OWNER, actorRole: "owner", role: "root" }).allowed,
    ).toBe(false)
  })
})

describe("settings/roles/invite-usability", () => {
  const now = new Date("2026-03-01T12:00:00.000Z")

  test("a live invite is usable", () => {
    expect(
      checkInviteUsable(
        { expiresAt: "2026-03-08T12:00:00.000Z", acceptedAt: null, revokedAt: null },
        now,
      ).allowed,
    ).toBe(true)
  })

  test("expired, revoked and already-used invites are not", () => {
    expect(
      checkInviteUsable(
        { expiresAt: "2026-02-28T12:00:00.000Z", acceptedAt: null, revokedAt: null },
        now,
      ).allowed,
    ).toBe(false)
    expect(
      checkInviteUsable(
        {
          expiresAt: "2026-03-08T12:00:00.000Z",
          acceptedAt: null,
          revokedAt: "2026-02-28T12:00:00.000Z",
        },
        now,
      ).allowed,
    ).toBe(false)
    expect(
      checkInviteUsable(
        {
          expiresAt: "2026-03-08T12:00:00.000Z",
          acceptedAt: "2026-02-28T12:00:00.000Z",
          revokedAt: null,
        },
        now,
      ).allowed,
    ).toBe(false)
  })

  test("an invite expiring exactly now is already dead", () => {
    expect(
      checkInviteUsable({ expiresAt: now.toISOString(), acceptedAt: null, revokedAt: null }, now)
        .allowed,
    ).toBe(false)
  })
})
