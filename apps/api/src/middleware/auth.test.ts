import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import {
  createMemoryAuthStore,
  hashPassword,
  loginUser,
  logoutUser,
  resolveSession,
  type AuthStore,
} from "@yourcrm/auth"
import type { AppEnv } from "../hono-env"
import { auth, requireSession } from "./auth"
import { authorize } from "../lib/authorization"

async function viewerStore(): Promise<{ store: AuthStore; viewerToken: string }> {
  const ownerHash = await hashPassword("OwnerPass123!")
  const viewerHash = await hashPassword("ViewerPass123!")
  const store = createMemoryAuthStore({
    users: [
      { id: "user_owner", email: "owner@yourcrm.local", name: "Owner" },
      { id: "user_viewer", email: "viewer@yourcrm.local", name: "Viewer" },
    ],
    memberships: [
      { userId: "user_owner", workspaceId: "ws_acme", role: "owner" },
      { userId: "user_viewer", workspaceId: "ws_acme", role: "viewer" },
    ],
    passwordHashes: { user_owner: ownerHash, user_viewer: viewerHash },
  })
  const login = await loginUser(
    store,
    { email: "viewer@yourcrm.local", password: "ViewerPass123!" },
    { ip: "10.9.0.1" },
  )
  return { store, viewerToken: login.token }
}

function testApp(store: AuthStore) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("requestId", "test-request")
    await next()
  })
  app.use("*", auth(store))
  app.get("/me", requireSession(), (c) => {
    const session = c.get("session")
    return c.json({
      data: { user: session?.user, workspaceId: session?.workspaceId },
    })
  })
  return app
}

describe("api/middleware/auth", () => {
  test("valid session cookie returns the real user on /me", async () => {
    const { store, viewerToken } = await viewerStore()
    const res = await testApp(store).request("/me", {
      headers: { cookie: `yourcrm_session=${viewerToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { user: { email: string } } }
    expect(body.data.user.email).toBe("viewer@yourcrm.local")
  })

  test("bearer tokens authenticate API clients", async () => {
    const { store, viewerToken } = await viewerStore()
    const res = await testApp(store).request("/me", {
      headers: { authorization: `Bearer ${viewerToken}` },
    })
    expect(res.status).toBe(200)
  })

  test("revoked sessions are rejected with 401", async () => {
    const { store, viewerToken } = await viewerStore()
    await logoutUser(store, viewerToken)
    const res = await testApp(store).request("/me", {
      headers: { cookie: `yourcrm_session=${viewerToken}` },
    })
    expect(res.status).toBe(401)
  })

  test("missing sessions still return 401 (no DB required)", async () => {
    const res = await testApp(createMemoryAuthStore()).request("/me")
    expect(res.status).toBe(401)
  })

  test("viewer role is denied destructive actions via authorize()", async () => {
    const { store, viewerToken } = await viewerStore()
    const session = await resolveSession(store, viewerToken)
    expect(session?.memberships).toEqual([{ workspaceId: "ws_acme", role: "viewer" }])
    expect(() => authorize(session, { object: "deal", action: "delete" })).toThrow()
    expect(authorize(session, { object: "deal", action: "read" }).actorId).toBe("user_viewer")
  })
})
