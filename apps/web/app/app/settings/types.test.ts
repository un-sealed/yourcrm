import { describe, expect, test } from "bun:test"
import {
  assignableRoles,
  auditChangedKeys,
  auditQueryString,
  DEFAULT_AUDIT_FILTERS,
  dataRequestStatusLabel,
  describeAuditEvent,
  formatSettingsTimestamp,
  inviteState,
  isSettingsSection,
  memberStatusLabel,
  roleTone,
  SETTINGS_SECTIONS,
  type AuditEvent,
  type WorkspaceInvite,
} from "./types"

const NOW = new Date("2026-03-01T12:00:00.000Z")

function invite(overrides: Partial<WorkspaceInvite> = {}): WorkspaceInvite {
  return {
    id: "invite-1",
    email: "a@example.com",
    role: "member",
    expiresAt: "2026-03-08T12:00:00.000Z",
    acceptedAt: null,
    revokedAt: null,
    createdAt: "2026-03-01T12:00:00.000Z",
    ...overrides,
  }
}

function auditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "audit-1",
    actorId: "user-1",
    action: "membership.role_changed",
    object: "membership",
    recordId: "mem-1",
    before: { role: "member", active: true },
    after: { role: "admin", active: true },
    correlationId: "req-1",
    source: "user",
    createdAt: "2026-03-01T12:00:00.000Z",
    ...overrides,
  }
}

describe("settings/sections", () => {
  test("every section has a stable value and a label", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.value)).toEqual([
      "workspace",
      "members",
      "teams",
      "audit",
      "privacy",
    ])
    expect(isSettingsSection("audit")).toBe(true)
    expect(isSettingsSection("billing")).toBe(false)
    expect(isSettingsSection(null)).toBe(false)
  })
})

describe("settings/role presentation", () => {
  test("the role menu never offers a role above the actor's own", () => {
    expect(assignableRoles("owner")).toEqual(["owner", "admin", "member", "viewer"])
    expect(assignableRoles("admin")).toEqual(["admin", "member", "viewer"])
    expect(assignableRoles("member")).toEqual(["member", "viewer"])
    expect(assignableRoles("nonsense")).toEqual([])
  })

  test("role tone is decoration; the role word is always rendered too", () => {
    expect(roleTone("owner")).toBe("warning")
    expect(roleTone("admin")).toBe("info")
    expect(roleTone("viewer")).toBe("secondary")
    expect(roleTone("member")).toBe("success")
  })

  test("member status reads as words, not colour", () => {
    expect(memberStatusLabel({ active: true })).toBe("Active")
    expect(memberStatusLabel({ active: false })).toBe("Deactivated")
  })
})

describe("settings/invite state", () => {
  test("a live invite is pending; expiry, revocation and use are distinct", () => {
    expect(inviteState(invite(), NOW)).toBe("pending")
    expect(inviteState(invite({ expiresAt: "2026-02-01T00:00:00.000Z" }), NOW)).toBe("expired")
    expect(inviteState(invite({ revokedAt: "2026-02-20T00:00:00.000Z" }), NOW)).toBe("revoked")
    expect(inviteState(invite({ acceptedAt: "2026-02-20T00:00:00.000Z" }), NOW)).toBe("accepted")
  })

  test("a revoked invite reads as revoked even before it expires", () => {
    expect(
      inviteState(
        invite({ revokedAt: "2026-02-20T00:00:00.000Z", expiresAt: "2026-01-01T00:00:00.000Z" }),
        NOW,
      ),
    ).toBe("revoked")
  })
})

describe("settings/audit query", () => {
  test("empty filters produce only the limit", () => {
    expect(auditQueryString(DEFAULT_AUDIT_FILTERS, null)).toBe("limit=25")
  })

  test("dates widen to full-day ISO bounds and the cursor rides along", () => {
    const query = auditQueryString(
      { object: "membership", action: "", source: "user", from: "2026-03-01", to: "2026-03-02" },
      "2026-03-01T00:00:00.000Z|abc",
      50,
    )
    const params = new URLSearchParams(query)
    expect(params.get("limit")).toBe("50")
    expect(params.get("object")).toBe("membership")
    expect(params.get("action")).toBeNull()
    expect(params.get("from")).toBe("2026-03-01T00:00:00.000Z")
    expect(params.get("to")).toBe("2026-03-02T23:59:59.999Z")
    expect(params.get("cursor")).toBe("2026-03-01T00:00:00.000Z|abc")
  })
})

describe("settings/audit presentation", () => {
  test("an event describes itself without internal punctuation", () => {
    expect(describeAuditEvent(auditEvent())).toBe("membership role changed on membership mem-1")
    expect(describeAuditEvent(auditEvent({ recordId: null, object: "workspace_settings" }))).toBe(
      "membership role changed on workspace settings",
    )
  })

  test("only genuinely changed keys are listed", () => {
    expect(auditChangedKeys(auditEvent())).toEqual(["role"])
    expect(auditChangedKeys(auditEvent({ before: null, after: null }))).toEqual([])
    expect(auditChangedKeys(auditEvent({ before: undefined, after: { role: "owner" } }))).toEqual([
      "role",
    ])
  })

  test("timestamps degrade to an em dash rather than Invalid Date", () => {
    expect(formatSettingsTimestamp(null)).toBe("—")
    expect(formatSettingsTimestamp("not-a-date")).toBe("—")
    expect(formatSettingsTimestamp("2026-03-01T12:00:00.000Z")).not.toBe("—")
  })
})

describe("settings/data requests", () => {
  test("soft-deleted is labelled honestly, not as 'deleted'", () => {
    expect(dataRequestStatusLabel("soft_deleted")).toContain("Soft-deleted")
    expect(dataRequestStatusLabel("soft_deleted")).toContain("purge")
    expect(dataRequestStatusLabel("pending")).toBe("Pending")
    expect(dataRequestStatusLabel("weird")).toBe("weird")
  })
})
