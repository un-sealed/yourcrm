import { afterEach, describe, expect, test } from "bun:test"
import { createApp } from "../app"
import { resetMetrics } from "./health"

const env = process.env

describe("observability endpoints", () => {
  afterEach(() => {
    resetMetrics()
    delete env.METRICS_ENABLED
  })

  test("GET /ready reports per-dependency status and degrades instead of throwing", async () => {
    const res = await createApp().request("/ready")
    expect(res.status).toBe(200)
    expect(res.headers.get("x-request-id")).toBeTruthy()
    const body = (await res.json()) as {
      status: string
      version: string
      requestId?: string
      checks: Record<string, { ok: boolean; latencyMs?: number; error?: string }>
    }
    expect(["ok", "degraded"]).toContain(body.status)
    for (const name of ["database", "redis", "storage", "worker", "queues"]) {
      expect(body.checks[name]).toBeDefined()
    }
    // Failure details are generic — never connection strings or secrets.
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain("postgres://")
    expect(serialized).not.toContain("minioadmin")
  })

  test("GET /metrics is 404 unless METRICS_ENABLED", async () => {
    const app = createApp()
    const res = await app.request("/metrics")
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND")
  })

  test("GET /metrics renders Prometheus text once enabled", async () => {
    env.METRICS_ENABLED = "1"
    const app = createApp()
    await app.request("/health")
    await app.request("/ready")
    const res = await app.request("/metrics")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/plain")
    const text = await res.text()
    expect(text).toContain("yourcrm_http_requests_total")
    expect(text).toContain("yourcrm_http_request_duration_ms_bucket")
    expect(text).toContain("yourcrm_process_uptime_seconds")
    expect(text).toContain("yourcrm_dependency_up")
  })

  test("request counting observes route and status labels", async () => {
    env.METRICS_ENABLED = "true"
    const app = createApp()
    await app.request("/api/v1/ping")
    await app.request("/nope")
    const text = await (await app.request("/metrics")).text()
    expect(text).toMatch(/yourcrm_http_requests_total\{[^}]*route="\/api\/v1\/ping"[^}]*\} 1/)
    expect(text).toMatch(/yourcrm_http_requests_total\{[^}]*status="404"[^}]*\} 1/)
  })
})
