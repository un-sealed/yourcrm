import { describe, expect, test } from "bun:test"
import { createBaseRepository } from "./repositories"
import { auditEvents, memberships, notifications, users, workspaces } from "./schema"

// Compile-time proof: workspace-scoped tables satisfy the BaseTable contract.
createBaseRepository(memberships)
createBaseRepository(auditEvents)
createBaseRepository(notifications)

function columns(table: object): Record<string, unknown> {
  return table as unknown as Record<string, unknown>
}

describe("database/schema", () => {
  test("foundation tables expose the BaseRecord column contract", () => {
    for (const table of [workspaces, users, memberships, auditEvents, notifications]) {
      for (const col of ["id", "createdAt", "updatedAt", "deletedAt"] as const) {
        expect(columns(table)[col], `${col} on foundation table`).toBeDefined()
      }
    }
  })

  test("workspace scoping columns exist where required", () => {
    expect(columns(memberships).workspaceId).toBeDefined()
    expect(columns(auditEvents).workspaceId).toBeDefined()
    expect(columns(notifications).workspaceId).toBeDefined()
  })
})
