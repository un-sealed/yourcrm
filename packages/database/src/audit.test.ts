import { describe, expect, test } from "bun:test"
import { auditSourceSchema, writeAudit, type AuditDb } from "./audit"
import { auditEvents } from "./schema"

/** Hermetic stand-in for Drizzle: captures `insert(...).values(...)`. */
function createFakeDb() {
  const calls: { table: unknown; values: unknown }[] = []
  const db = {
    calls,
    insert(table: unknown) {
      return {
        values(values: unknown) {
          calls.push({ table, values })
          return {
            returning: () => Promise.resolve([{ ...(values as object), id: "audit-row-id" }]),
          }
        },
      }
    },
  }
  return db
}

describe("database/audit", () => {
  test("writes the full audit contract with user-source default", async () => {
    const db = createFakeDb()
    const rows = await writeAudit(db as unknown as AuditDb, {
      workspaceId: "w1",
      actorId: "u1",
      action: "deal.update",
      object: "deal",
      recordId: "d1",
      before: { stage: "new" },
      after: { stage: "won" },
      correlationId: "req-123",
    })

    expect(db.calls).toHaveLength(1)
    expect(db.calls[0]?.table).toBe(auditEvents)
    expect(db.calls[0]?.values).toMatchObject({
      workspaceId: "w1",
      actorId: "u1",
      action: "deal.update",
      object: "deal",
      recordId: "d1",
      before: { stage: "new" },
      after: { stage: "won" },
      correlationId: "req-123",
      source: "user",
      createdBy: "u1",
    })
    expect(rows).toHaveLength(1)
  })

  test("explicit source and nulls pass through", async () => {
    const db = createFakeDb()
    await writeAudit(db as unknown as AuditDb, {
      workspaceId: "w1",
      action: "import.completed",
      object: "import",
      source: "automation",
    })

    expect(db.calls[0]?.values).toMatchObject({
      actorId: null,
      recordId: null,
      before: null,
      after: null,
      correlationId: null,
      source: "automation",
      createdBy: null,
    })
  })

  test("audit source contract rejects unknown sources", () => {
    expect(auditSourceSchema.safeParse("user").success).toBe(true)
    expect(auditSourceSchema.safeParse("system").success).toBe(false)
    expect(auditSourceSchema.options).toEqual(["user", "automation", "ai", "integration", "mcp"])
  })
})
