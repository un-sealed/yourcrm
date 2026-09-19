import { describe, expect, test } from "bun:test"
import {
  createMemoryAuthStore,
  hashPassword,
  LoginRateLimiter,
  type AuthStore,
  type LoginRateLimiters,
} from "@yourcrm/auth"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { auth } from "../../middleware/auth"
import { createRoutes } from "./auth"

/**
 * Hermetic API tests: the route factory takes an `AuthStore`, so tests run
 * against `createMemoryAuthStore()` — no live Postgres. The global `auth()`
 * middleware is mounted too (not just this module's routes) so `/me`
 * exercises the real cookie -> session resolution path, exactly as the
 * running server does.
 */
function testApp(store: AuthStore, limiters?: LoginRateLimiters) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("requestId", "test-request")
    await next()
  })
  app.use("*", auth(store))
  app.route("/api/v1/auth", createRoutes({ store, limiters }))
  return app
}

async function seededStore(): Promise<AuthStore> {
  const passwordHash = await hashPassword("Password123!")
  return createMemoryAuthStore({
    users: [{ id: "user_1", email: "owner@yourcrm.local", name: "Owner" }],
    memberships: [{ userId: "user_1", workspaceId: "ws_1", role: "owner" }],
    passwordHashes: { user_1: passwordHash },
  })
}

function postJson(
  app: Hono<AppEnv>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

function sessionTokenFromCookie(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? ""
  const match = raw.match(/yourcrm_session=([^;]+)/)
  if (!match?.[1]) throw new Error(`no session cookie in Set-Cookie header: ${raw}`)
  return decodeURIComponent(match[1])
}

describe("api/auth", () => {
  test("signup creates a user + workspace, sets a spec-compliant cookie, 201", async () => {
    const app = testApp(createMemoryAuthStore())
    const res = await postJson(app, "/api/v1/auth/signup", {
      name: "Ada Lovelace",
      email: "ada@example.com",
      password: "Password123!",
    })
    expect(res.status).toBe(201)

    const cookie = res.headers.get("set-cookie") ?? ""
    expect(cookie).toContain("yourcrm_session=")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Lax")
    expect(cookie).toContain("Path=/")
    // Dev/test runs over plain http — must not be marked Secure or the demo breaks.
    expect(cookie).not.toContain("Secure")

    const body = (await res.json()) as {
      data: { user: { email: string }; workspaceId: string | null }
    }
    expect(body.data.user.email).toBe("ada@example.com")
    expect(body.data.workspaceId).toBeTruthy()
  })

  test("signup with a taken email is 409 EMAIL_TAKEN", async () => {
    const app = testApp(await seededStore())
    const res = await postJson(app, "/api/v1/auth/signup", {
      name: "Duplicate",
      email: "owner@yourcrm.local",
      password: "Password123!",
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("EMAIL_TAKEN")
  })

  test("signup validates the request body", async () => {
    const app = testApp(createMemoryAuthStore())
    const res = await postJson(app, "/api/v1/auth/signup", {
      name: "",
      email: "not-an-email",
      password: "short",
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("VALIDATION_ERROR")
  })

  test("login with correct credentials sets the cookie and returns the session", async () => {
    const app = testApp(await seededStore())
    const res = await postJson(app, "/api/v1/auth/login", {
      email: "owner@yourcrm.local",
      password: "Password123!",
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("set-cookie")).toContain("yourcrm_session=")
    const body = (await res.json()) as { data: { user: { email: string }; workspaceId: string } }
    expect(body.data.user.email).toBe("owner@yourcrm.local")
    expect(body.data.workspaceId).toBe("ws_1")
  })

  test("login failures are generic whether the email is unknown or the password is wrong", async () => {
    const app = testApp(await seededStore())
    const unknownEmail = await postJson(app, "/api/v1/auth/login", {
      email: "nope@yourcrm.local",
      password: "Password123!",
    })
    const wrongPassword = await postJson(app, "/api/v1/auth/login", {
      email: "owner@yourcrm.local",
      password: "WrongPass123!",
    })
    expect(unknownEmail.status).toBe(401)
    expect(wrongPassword.status).toBe(401)
    const unknownBody = (await unknownEmail.json()) as { error: { code: string; message: string } }
    const wrongBody = (await wrongPassword.json()) as { error: { code: string; message: string } }
    expect(unknownBody.error.code).toBe("INVALID_CREDENTIALS")
    expect(unknownBody.error.message).toBe("Invalid email or password")
    expect(wrongBody.error.message).toBe("Invalid email or password")
    // No cookie is set on failure.
    expect(unknownEmail.headers.get("set-cookie")).toBeNull()
  })

  test("login is rate limited per account", async () => {
    const store = await seededStore()
    const limiters = {
      perIp: new LoginRateLimiter({ maxAttempts: 30 }),
      perAccount: new LoginRateLimiter({ maxAttempts: 2 }),
    }
    const app = testApp(store, limiters)
    const attempt = () =>
      postJson(app, "/api/v1/auth/login", {
        email: "owner@yourcrm.local",
        password: "WrongPass123!",
      })
    await attempt()
    await attempt()
    const third = await attempt()
    expect(third.status).toBe(429)
    const body = (await third.json()) as { error: { code: string } }
    expect(body.error.code).toBe("RATE_LIMITED")
  })

  test("logout revokes the session and clears the cookie; /me then 401", async () => {
    const app = testApp(await seededStore())
    const loginRes = await postJson(app, "/api/v1/auth/login", {
      email: "owner@yourcrm.local",
      password: "Password123!",
    })
    const token = sessionTokenFromCookie(loginRes)

    const meBefore = await app.request("/api/v1/auth/me", {
      headers: { cookie: `yourcrm_session=${token}` },
    })
    expect(meBefore.status).toBe(200)

    const logoutRes = await app.request("/api/v1/auth/logout", {
      method: "POST",
      headers: { cookie: `yourcrm_session=${token}` },
    })
    expect(logoutRes.status).toBe(200)
    expect(logoutRes.headers.get("set-cookie")).toContain("Max-Age=0")

    const meAfter = await app.request("/api/v1/auth/me", {
      headers: { cookie: `yourcrm_session=${token}` },
    })
    expect(meAfter.status).toBe(401)
  })

  test("logout is idempotent with no session cookie present", async () => {
    const app = testApp(await seededStore())
    const res = await app.request("/api/v1/auth/logout", { method: "POST" })
    expect(res.status).toBe(200)
  })

  test("me without a session is 401", async () => {
    const app = testApp(await seededStore())
    const res = await app.request("/api/v1/auth/me")
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("UNAUTHORIZED")
  })

  test("me with a valid session returns the current user", async () => {
    const app = testApp(await seededStore())
    const loginRes = await postJson(app, "/api/v1/auth/login", {
      email: "owner@yourcrm.local",
      password: "Password123!",
    })
    const token = sessionTokenFromCookie(loginRes)
    const res = await app.request("/api/v1/auth/me", {
      headers: { cookie: `yourcrm_session=${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { user: { email: string } } }
    expect(body.data.user.email).toBe("owner@yourcrm.local")
  })
})
