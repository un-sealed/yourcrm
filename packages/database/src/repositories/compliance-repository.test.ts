import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import { createAuditLogReader, createDataRequestRepository } from "./compliance-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const SUBJECT = "77777777-7777-4777-8777-777777777777"
const AUDIT_SOURCE = new URL("./compliance-repository.ts", import.meta.url)

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

function auditRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "audit-1",
    workspaceId: WS,
    actorId: "user-1",
    action: "settings.update",
    object: "workspace_settings",
    recordId: WS,
    before: { name: "Acme" },
    after: { name: "Acme Inc" },
    correlationId: "req-1",
    source: "user",
    createdAt: new Date("2026-03-01T00:00:00Z"),
    ...overrides,
  }
}

describe("compliance/audit-reader", () => {
  test("APPEND-ONLY: the reader exposes reads and nothing else", () => {
    const reader = createAuditLogReader() as unknown as Record<string, unknown>
    expect(Object.keys(reader).sort()).toEqual(["findById", "list"])
    for (const forbidden of ["update", "delete", "softDelete", "restore", "insert", "create"]) {
      expect(reader[forbidden], forbidden).toBeUndefined()
    }
  })

  test("APPEND-ONLY: the source file issues no UPDATE or DELETE against audit_events", async () => {
    const source = await readFile(AUDIT_SOURCE, "utf8")
    // `db.update(auditEvents)` / `db.delete(auditEvents)` must not exist.
    expect(source).not.toMatch(/\.update\(\s*auditEvents/)
    expect(source).not.toMatch(/\.delete\(\s*auditEvents/)
    expect(source).not.toMatch(/\.insert\(\s*auditEvents/)
  })

  test("audit rows are returned with ISO timestamps and cursor pagination", async () => {
    const reader = createAuditLogReader()
    const page = await reader.list(mockDb([[auditRow(), auditRow({ id: "audit-2" })]]), WS, {
      limit: 1,
    })
    expect(page.data).toHaveLength(1)
    expect(page.data[0]?.createdAt).toBe("2026-03-01T00:00:00.000Z")
    expect(page.pagination.nextCursor).toBe("2026-03-01T00:00:00.000Z|audit-1")
    expect(page.pagination.limit).toBe(1)
  })

  test("a single audit event reads back, and a missing one is null", async () => {
    const reader = createAuditLogReader()
    expect((await reader.findById(mockDb([[auditRow()]]), WS, "audit-1"))?.action).toBe(
      "settings.update",
    )
    expect(await reader.findById(mockDb([[]]), WS, "nope")).toBeNull()
  })
})

describe("compliance/data-requests", () => {
  test("a created request records ids and status only", async () => {
    const repo = createDataRequestRepository()
    const db = mockDb([
      [
        {
          id: "req-1",
          workspaceId: WS,
          kind: "deletion",
          subjectType: "person",
          subjectId: SUBJECT,
          status: "pending",
          reason: "erasure request",
          requestedBy: "user-1",
          completedAt: null,
          completedBy: null,
          createdAt: new Date("2026-03-01T00:00:00Z"),
        },
      ],
    ])
    const created = await repo.create(
      db,
      WS,
      { kind: "deletion", subjectType: "person", subjectId: SUBJECT, reason: "erasure request" },
      "user-1",
    )
    expect(created.status).toBe("pending")
    expect(created.subjectId).toBe(SUBJECT)
    expect(Object.keys(created)).not.toContain("payload")
  })

  test("marking a status stamps completion without deleting anything", async () => {
    const repo = createDataRequestRepository()
    const db = mockDb([
      [
        {
          id: "req-1",
          workspaceId: WS,
          kind: "deletion",
          subjectType: "person",
          subjectId: SUBJECT,
          status: "soft_deleted",
          reason: null,
          requestedBy: "user-1",
          completedAt: new Date("2026-03-01T01:00:00Z"),
          completedBy: "user-1",
          createdAt: new Date("2026-03-01T00:00:00Z"),
        },
      ],
    ])
    const updated = await repo.markStatus(db, WS, "req-1", "soft_deleted", "user-1")
    expect(updated?.status).toBe("soft_deleted")
    expect(updated?.completedAt).toBe("2026-03-01T01:00:00.000Z")
  })

  test("the repository has no hard-delete path in P0", () => {
    const repo = createDataRequestRepository() as unknown as Record<string, unknown>
    expect(Object.keys(repo).sort()).toEqual(["create", "findById", "list", "markStatus"])
  })
})
