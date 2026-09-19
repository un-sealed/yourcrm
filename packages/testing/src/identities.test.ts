import { beforeEach, describe, expect, test } from "bun:test"
import { roleInWorkspace } from "@yourcrm/auth"
import { makeMembership, makeSession, makeUser, makeWorkspace } from "./identities"
import { resetIdCounter } from "./time"

describe("testing/identities", () => {
  beforeEach(() => {
    resetIdCounter()
  })

  test("makeWorkspace has deterministic defaults and overrides", () => {
    const ws = makeWorkspace()
    expect(ws.id).toBe("ws_0001")
    expect(ws.name).toContain("ws_0001")
    expect(makeWorkspace({ id: "ws_acme", name: "Acme" })).toEqual({
      id: "ws_acme",
      name: "Acme",
    })
  })

  test("makeUser defaults email from id", () => {
    const user = makeUser()
    expect(user.id).toBe("user_0001")
    expect(user.email).toBe("user_0001@example.com")
    expect(makeUser({ email: "ada@example.com" }).email).toBe("ada@example.com")
  })

  test("makeMembership defaults to member", () => {
    expect(makeMembership().role).toBe("member")
    expect(makeMembership({ role: "viewer" }).role).toBe("viewer")
  })

  test("makeSession defaults to an owner session", () => {
    const session = makeSession()
    expect(session.workspaceId).toBe("ws_0002")
    expect(session.user.id).toBe("user_0001")
    expect(session.user.email).toBe("user_0001@example.com")
    expect(roleInWorkspace(session)).toBe("owner")
  })

  test("makeSession({ role }) sets the membership role", () => {
    const session = makeSession({ role: "viewer", workspaceId: "ws_acme" })
    expect(roleInWorkspace(session)).toBe("viewer")
    expect(session.memberships).toEqual([{ workspaceId: "ws_acme", role: "viewer" }])
  })

  test("makeSession honors workspace, user and session overrides", () => {
    const session = makeSession({
      workspaceId: "ws_acme",
      userId: "u_ada",
      email: "ada@example.com",
      name: "Ada",
      role: "admin",
    })
    expect(session.workspaceId).toBe("ws_acme")
    expect(session.user).toEqual({ id: "u_ada", email: "ada@example.com", name: "Ada" })
    expect(roleInWorkspace(session)).toBe("admin")
  })
})
