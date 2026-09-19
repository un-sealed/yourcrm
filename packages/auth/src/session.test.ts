import { describe, expect, test } from "bun:test"
import { devSession, requireWorkspace, roleInWorkspace } from "./session"

describe("auth/session", () => {
  test("dev session carries an active workspace", () => {
    expect(requireWorkspace(devSession())).toBe("ws_dev")
  })

  test("missing workspace throws", () => {
    expect(() => requireWorkspace({ ...devSession(), workspaceId: undefined })).toThrow()
  })

  test("role resolves from memberships", () => {
    expect(roleInWorkspace(devSession())).toBe("owner")
  })
})
