import { describe, expect, test } from "bun:test"
import { createApp } from "./app"

describe("api", () => {
  test("GET /health is a cheap liveness probe with the stable shape", async () => {
    const res = await createApp().request("/health")
    expect(res.status).toBe(200)
    expect(res.headers.get("x-request-id")).toBeTruthy()
    const body = (await res.json()) as {
      status: string
      version: string
      checks: Record<string, { ok: boolean }>
    }
    // Liveness is always ok and keeps the shape the web status card reads.
    expect(body.status).toBe("ok")
    expect(body.version).toBeTruthy()
    expect(body.checks.database).toBeDefined()
    expect(body.checks.redis).toBeDefined()
    expect(body.checks.storage).toBeDefined()
  })

  test("GET /api/v1/ping proves versioning", async () => {
    const res = await createApp().request("/api/v1/ping")
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: { pong: boolean } }).data.pong).toBe(true)
  })

  test("POST /api/v1/echo validates the boundary", async () => {
    const app = createApp()
    const ok = await app.request("/api/v1/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    })
    expect(ok.status).toBe(200)

    const bad = await app.request("/api/v1/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "" }),
    })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR")
  })

  test("GET /api/v1/me requires a session (auth integration point)", async () => {
    const res = await createApp().request("/api/v1/me")
    expect(res.status).toBe(401)
  })

  test("unknown routes use the error envelope", async () => {
    const res = await createApp().request("/nope")
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND")
  })
})
