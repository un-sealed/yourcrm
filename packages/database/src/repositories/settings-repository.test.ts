import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import { workspaces } from "../schema/core"
import {
  dataRequests,
  workspaceInvites,
  workspaceTeamMembers,
  workspaceTeams,
} from "../schema/settings"
import {
  clampSettingsLimit,
  createWorkspaceSettingsRepository,
  decodeSettingsCursor,
  encodeSettingsCursor,
  normalizeInviteEmail,
  paginateSettingsRows,
} from "./settings-repository"
import { createWorkspaceTeamRepository, normalizeTeamSlug } from "./teams-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const MIGRATION = new URL("../../migrations/0320_settings.sql", import.meta.url)

/** Thenable chain stub: every builder call returns the proxy; each await pops one result. */
function mockDb(queued: unknown[][] = []) {
  let step = 0
  const proxy = new Proxy(function () {}, {
    get(_target, prop: string | symbol) {
      if (prop === "then") {
        return (resolve: (value: unknown) => void) => {
          resolve(queued[step] ?? [])
          step += 1
        }
      }
      return (..._args: unknown[]) => proxy
    },
  })
  return proxy as unknown as Database
}

describe("settings/schema", () => {
  test("the workspace row carries the profile columns the module edits", () => {
    const cols = workspaces as unknown as Record<string, unknown>
    for (const col of ["name", "timezone", "currency", "dateFormat", "logoUrl", "brandColor"]) {
      expect(cols[col], col).toBeDefined()
    }
  })

  test("teams and team_members follow the BaseRecord contract", () => {
    for (const table of [workspaceTeams, workspaceTeamMembers]) {
      const cols = table as unknown as Record<string, unknown>
      for (const col of ["id", "workspaceId", "createdAt", "updatedAt", "deletedAt"]) {
        expect(cols[col], col).toBeDefined()
      }
    }
    const edge = workspaceTeamMembers as unknown as Record<string, unknown>
    expect(edge.teamId).toBeDefined()
    expect(edge.membershipId).toBeDefined()
    expect(edge.teamRole).toBeDefined()
  })

  test("invites store a hash and an expiry, never a raw token", () => {
    const cols = Object.keys(workspaceInvites as unknown as Record<string, unknown>)
    expect(cols).toContain("tokenHash")
    expect(cols).toContain("expiresAt")
    expect(cols).not.toContain("token")
    expect(cols).not.toContain("password")
  })

  test("data requests hold ids and status, never subject data", () => {
    const cols = Object.keys(dataRequests as unknown as Record<string, unknown>)
    expect(cols).toContain("subjectId")
    expect(cols).toContain("status")
    for (const leaked of ["payload", "data", "email", "firstName", "snapshot"]) {
      expect(cols).not.toContain(leaked)
    }
  })
})

describe("settings/migration", () => {
  test("extends the workspaces row instead of adding a settings table", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("ALTER TABLE workspaces")
    expect(sql).toContain("date_format")
    expect(sql).toContain("brand_color")
    expect(sql).not.toContain("CREATE TABLE IF NOT EXISTS workspace_settings")
  })

  test("foreign keys point only at workspaces, users and this module's teams", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const references = [...sql.matchAll(/REFERENCES\s+(\w+)/g)].map((m) => m[1])
    expect(references.length).toBeGreaterThan(0)
    expect([...new Set(references)].sort()).toEqual(["teams", "users", "workspaces"])
    // memberships and people are other modules' tables: plain uuid columns.
    expect(sql).toContain("membership_id UUID NOT NULL")
    expect(sql).toContain("subject_id UUID NOT NULL")
  })

  test("the invite token column is a unique hash with an expiry", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("token_hash VARCHAR(64) NOT NULL")
    expect(sql).toContain("workspace_invites_token_uidx")
    expect(sql).toContain("expires_at TIMESTAMPTZ NOT NULL")
  })

  test("APPEND-ONLY: the migration installs a trigger rejecting audit mutations", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("audit_events_reject_mutation")
    expect(sql).toContain("BEFORE UPDATE OR DELETE ON audit_events")
    expect(sql).toContain("BEFORE TRUNCATE ON audit_events")
    expect(sql).toContain("RAISE EXCEPTION")
  })

  test("no table in this migration is hard-deletable by design (soft delete column present)", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const creates = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)]
    expect(creates).toHaveLength(4)
    for (const [, name, body] of creates) {
      expect(body, name).toContain("deleted_at TIMESTAMPTZ")
    }
  })
})

describe("settings/cursor", () => {
  test("encode/decode round-trips the (createdAt, id) keyset", () => {
    const at = new Date("2026-03-01T12:00:00.000Z")
    const cursor = encodeSettingsCursor(at, "abc")
    const decoded = decodeSettingsCursor(cursor)
    expect(decoded?.createdAt.toISOString()).toBe(at.toISOString())
    expect(decoded?.id).toBe("abc")
  })

  test("empty cursors decode to null and malformed ones throw", () => {
    expect(decodeSettingsCursor(null)).toBeNull()
    expect(decodeSettingsCursor("")).toBeNull()
    expect(() => decodeSettingsCursor("garbage")).toThrow()
    expect(() => decodeSettingsCursor("not-a-date|abc")).toThrow()
    expect(() => decodeSettingsCursor("2026-03-01T12:00:00.000Z|")).toThrow()
  })

  test("pagination emits a next cursor only when a further page exists", () => {
    const rows = [
      { id: "a", createdAt: "2026-03-03T00:00:00.000Z" },
      { id: "b", createdAt: "2026-03-02T00:00:00.000Z" },
      { id: "c", createdAt: "2026-03-01T00:00:00.000Z" },
    ]
    const page = paginateSettingsRows(rows, 2)
    expect(page.data.map((r) => r.id)).toEqual(["a", "b"])
    expect(page.pagination.nextCursor).toBe("2026-03-02T00:00:00.000Z|b")
    expect(paginateSettingsRows(rows, 5).pagination.nextCursor).toBeNull()
  })

  test("limits are clamped to the shared 1..200 range", () => {
    expect(clampSettingsLimit(undefined)).toBe(25)
    expect(clampSettingsLimit(0)).toBe(1)
    expect(clampSettingsLimit(5000)).toBe(200)
  })
})

describe("settings/normalization", () => {
  test("invite emails are trimmed and lowercased", () => {
    expect(normalizeInviteEmail("  New.Person@Example.COM ")).toBe("new.person@example.com")
    expect(() => normalizeInviteEmail("   ")).toThrow()
    expect(() => normalizeInviteEmail(`${"x".repeat(320)}@example.com`)).toThrow()
  })

  test("team slugs are lower-kebab and non-empty", () => {
    expect(normalizeTeamSlug("  Field  Sales EMEA! ")).toBe("field-sales-emea")
    expect(() => normalizeTeamSlug("   ")).toThrow()
    expect(() => normalizeTeamSlug("!!!")).toThrow()
  })
})

describe("settings/repository", () => {
  test("member rows expose an active flag derived from the soft delete", async () => {
    const repo = createWorkspaceSettingsRepository()
    const db = mockDb([
      [
        {
          membershipId: "mem-1",
          userId: "user-1",
          email: "a@example.com",
          name: "A",
          role: "admin",
          deletedAt: null,
          createdAt: new Date("2026-03-01T00:00:00Z"),
          lastLoginAt: null,
        },
        {
          membershipId: "mem-2",
          userId: "user-2",
          email: "b@example.com",
          name: null,
          role: "member",
          deletedAt: new Date("2026-03-02T00:00:00Z"),
          createdAt: new Date("2026-02-01T00:00:00Z"),
          lastLoginAt: new Date("2026-02-20T00:00:00Z"),
        },
      ],
    ])
    const page = await repo.listMembers(db, WS, { limit: 10 })
    expect(page.data.map((m) => m.active)).toEqual([true, false])
    expect(page.data[0]?.joinedAt).toBe("2026-03-01T00:00:00.000Z")
    expect(page.pagination).toEqual({ nextCursor: null, limit: 10 })
  })

  test("owner counting reads the live count, never a cached column", async () => {
    const repo = createWorkspaceSettingsRepository()
    expect(await repo.countActiveOwners(mockDb([[{ value: "2" }]]), WS)).toBe(2)
    expect(await repo.countActiveOwners(mockDb([[]]), WS)).toBe(0)
  })

  test("the invite projection drops the token hash before it leaves the module", async () => {
    const repo = createWorkspaceSettingsRepository()
    const db = mockDb([
      [
        {
          id: "invite-1",
          workspaceId: WS,
          email: "a@example.com",
          role: "member",
          tokenHash: "deadbeef".repeat(8),
          expiresAt: new Date("2026-03-08T00:00:00Z"),
          acceptedAt: null,
          revokedAt: null,
          invitedBy: null,
          createdAt: new Date("2026-03-01T00:00:00Z"),
        },
      ],
    ])
    const created = await repo.createInvite(db, WS, {
      email: "A@Example.com",
      role: "member",
      tokenHash: "deadbeef".repeat(8),
      expiresAt: new Date("2026-03-08T00:00:00Z"),
    })
    expect(Object.keys(created)).not.toContain("tokenHash")
    expect(JSON.stringify(created)).not.toContain("deadbeef")
    expect(created.expiresAt).toBe("2026-03-08T00:00:00.000Z")
  })

  test("a duplicate team slug is a conflict rather than a second team", async () => {
    const repo = createWorkspaceTeamRepository()
    const db = mockDb([
      [
        {
          id: "team-1",
          workspaceId: WS,
          name: "Sales",
          slug: "sales",
          description: null,
          createdAt: new Date("2026-03-01T00:00:00Z"),
          updatedAt: new Date("2026-03-01T00:00:00Z"),
        },
      ],
    ])
    await expect(repo.create(db, WS, { name: "Sales", slug: "sales" })).rejects.toMatchObject({
      code: "CONFLICT",
    })
  })
})
