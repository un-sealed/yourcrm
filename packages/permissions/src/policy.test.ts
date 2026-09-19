import { describe, expect, test } from "bun:test"
import { checkPermission, requirePermission } from "./policy"

describe("permissions/policy", () => {
  test("viewer can read but not delete", () => {
    expect(
      checkPermission({ workspaceId: "w", actorId: "u", role: "viewer", action: "read" }).allowed,
    ).toBe(true)
    expect(
      checkPermission({ workspaceId: "w", actorId: "u", role: "viewer", action: "delete" }).allowed,
    ).toBe(false)
  })

  test("requirePermission throws with FORBIDDEN code", () => {
    expect(() =>
      requirePermission({ workspaceId: "w", actorId: "u", role: "viewer", action: "admin" }),
    ).toThrow()
  })
})
