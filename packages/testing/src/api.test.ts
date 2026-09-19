import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import {
  createApiClient,
  decodeTestSession,
  encodeTestSession,
  TEST_SESSION_HEADER,
  type TestApp,
} from "./api"
import { makeSession } from "./identities"
import { resetIdCounter } from "./time"

/** Minimal Hono-shaped app honoring x-test-session (mirrors requireSession). */
function fakeApp(): TestApp & { lastHeaders: Record<string, string> | null } {
  const state = {
    lastHeaders: null as Record<string, string> | null,
    async request(
      path: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string },
    ) {
      const headers = init?.headers ?? {}
      state.lastHeaders = headers
      const json = (body: unknown, status: number, extraHeaders?: Record<string, string>) =>
        new Response(JSON.stringify(body), {
          status,
          headers: {
            "content-type": "application/json",
            "x-request-id": headers["x-request-id"] ?? "req_server",
            ...extraHeaders,
          },
        })
      if (path === "/items" && (init?.method ?? "GET") === "GET") {
        return json({ data: [{ id: "a" }], pagination: { nextCursor: null, limit: 25 } }, 200)
      }
      if (path === "/items" && init?.method === "POST") {
        return json({ data: JSON.parse(init.body ?? "null") }, 201)
      }
      if (path === "/me") {
        const session = decodeTestSession(headers[TEST_SESSION_HEADER] ?? null)
        if (!session) return json({ error: { code: "UNAUTHORIZED", message: "no" } }, 401)
        return json({ data: { user: (session as Session).user } }, 200)
      }
      if (path === "/broken") return json({ wrong: true }, 200)
      if (path === "/boom") return json({ error: { code: "FORBIDDEN", message: "no" } }, 403)
      return json({ error: { code: "NOT_FOUND", message: "nope" } }, 404)
    },
  }
  return state
}

describe("testing/api", () => {
  beforeEach(() => {
    resetIdCounter()
  })

  test("sends x-request-id and asserts the success envelope", async () => {
    const app = fakeApp()
    const api = createApiClient({ app })
    const res = await api.get("/items")
    expect(res.status).toBe(200)
    expect(res.requestId).toBe("req_0001")
    const body = res.expectSuccess()
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("posts JSON bodies and honors expectedStatus", async () => {
    const app = fakeApp()
    const api = createApiClient({ app })
    const res = await api.post("/items", { name: "Ada" }, { expectedStatus: 201 })
    expect(res.expectSuccess().data).toEqual({ name: "Ada" })
    await expect(api.post("/items", {}, { expectedStatus: 200 })).rejects.toThrow(
      "expected status 200 but got 201",
    )
  })

  test("session fixture authenticates and per-request session overrides", async () => {
    const app = fakeApp()
    const api = createApiClient({ app, session: makeSession({ role: "viewer" }) })
    const me = await api.get("/me")
    expect(me.expectSuccess().data).toMatchObject({ user: { email: expect.any(String) } })
    expect(app.lastHeaders?.["x-dev-session"]).toBe("1")
    expect(app.lastHeaders?.[TEST_SESSION_HEADER]).toBeTruthy()

    const anon = await createApiClient({ app }).get("/me")
    expect(anon.expectError("UNAUTHORIZED").error.code).toBe("UNAUTHORIZED")
  })

  test("expectSuccess fails on non-envelopes, expectError on non-errors", async () => {
    const app = fakeApp()
    const api = createApiClient({ app })
    const broken = await api.get("/broken")
    expect(() => broken.expectSuccess()).toThrow('no "data"')
    const items = await api.get("/items")
    expect(() => items.expectError()).toThrow("not an error envelope")
    const boom = await api.get("/boom")
    expect(() => boom.expectError("UNAUTHORIZED")).toThrow(
      'expected code "UNAUTHORIZED" but got "FORBIDDEN"',
    )
  })

  test("session header round-trips and rejects garbage", () => {
    const session = makeSession()
    expect(decodeTestSession(encodeTestSession(session))).toEqual(session)
    expect(decodeTestSession(null)).toBeNull()
    expect(decodeTestSession("garbage")).toBeNull()
  })
})
