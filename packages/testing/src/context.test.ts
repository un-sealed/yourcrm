import { beforeEach, describe, expect, test } from "bun:test"
import { makeServiceContext } from "./context"
import { makeSession } from "./identities"
import { resetIdCounter } from "./time"

describe("testing/context", () => {
  beforeEach(() => {
    resetIdCounter()
  })

  test("defaults are deterministic and owner-flavored", () => {
    const ctx = makeServiceContext()
    expect(ctx.workspaceId).toBe("ws_0001")
    expect(ctx.actorId).toBe("user_0002")
    expect(ctx.role).toBe("owner")
    expect(ctx.correlationId).toBe("corr_0003")
  })

  test("derives caller from a session", () => {
    const session = makeSession({ role: "viewer", workspaceId: "ws_acme", userId: "u_ada" })
    const ctx = makeServiceContext({ session })
    expect(ctx.workspaceId).toBe("ws_acme")
    expect(ctx.actorId).toBe("u_ada")
    expect(ctx.role).toBe("viewer")
  })

  test("explicit fields win over the session", () => {
    const session = makeSession({ role: "viewer", workspaceId: "ws_acme" })
    const ctx = makeServiceContext({ session, role: "admin", correlationId: "corr_9" })
    expect(ctx.role).toBe("admin")
    expect(ctx.correlationId).toBe("corr_9")
    expect(ctx.workspaceId).toBe("ws_acme")
  })
})
