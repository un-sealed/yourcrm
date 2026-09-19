import { describe, expect, test } from "bun:test"
import { createApp } from "../../app"
import { buildOpenApiDocument } from "../../openapi/document"
import { moduleRoutes } from "./index"
import { v1Routes } from "../v1"

describe("api/module-registry", () => {
  test("registry entries expose a base path plus a sub-app factory", () => {
    expect(moduleRoutes.length).toBeGreaterThan(0)
    for (const mod of moduleRoutes) {
      expect(typeof mod.path).toBe("string")
      expect(mod.path.startsWith("/")).toBe(true)
      const subApp = mod.createRoutes()
      expect(typeof subApp.request).toBe("function")
    }
  })

  test("module routers mount at their prefix with behavior preserved", async () => {
    const app = v1Routes()

    const ping = await app.request("/ping")
    expect(ping.status).toBe(200)
    expect(((await ping.json()) as { data: { pong: boolean } }).data.pong).toBe(true)

    const echo = await app.request("/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    })
    expect(echo.status).toBe(200)

    const badEcho = await app.request("/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "" }),
    })
    expect(badEcho.status).toBe(400)

    const me = await app.request("/me")
    expect(me.status).toBe(401)
  })

  test("full app serves registry routes under /api/v1", async () => {
    const app = createApp()
    const res = await app.request("/api/v1/ping")
    expect(res.status).toBe(200)
  })

  test("openapi document assembles from registered module routers", async () => {
    const doc = buildOpenApiDocument()
    for (const mod of moduleRoutes) {
      for (const path of Object.keys(mod.openApiPaths ?? {})) {
        expect(doc.paths[path]).toBeDefined()
      }
    }
    expect(doc.paths["/api/v1/ping"]).toBeDefined()
    expect(doc.paths["/api/v1/echo"]).toBeDefined()
    expect(doc.paths["/api/v1/me"]).toBeDefined()

    const res = await createApp().request("/openapi.json")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { openapi: string; paths: Record<string, unknown> }
    expect(body.openapi).toBe("3.1.0")
    expect(body.paths["/api/v1/ping"]).toBeDefined()
  })
})
