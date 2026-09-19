import { Hono } from "hono"
import { createMiddleware } from "hono/factory"
import type { AppEnv } from "../hono-env"
import { sql } from "drizzle-orm"
import { Redis } from "ioredis"
import { getDb } from "@yourcrm/database"
import { StorageService, storageConfigFromEnv } from "@yourcrm/storage"
import { getEnv } from "../env"

export type CheckResult = { ok: boolean; latencyMs?: number; error?: string; note?: string }

const API_VERSION = "0.1.0"

/** How long a single readiness dependency check may take before it counts as failed. */
const READY_TIMEOUT_MS = 2000

/** Queue names mirror `QueueNames` in apps/worker/src/queues.ts (source of truth). */
const KNOWN_QUEUES = [
  "yourcrm-default",
  "yourcrm-communications",
  "yourcrm-automation",
  "yourcrm-ai",
] as const

// ---------------------------------------------------------------------------
// Dependency checks (readiness only — never called from /health or /metrics)
// ---------------------------------------------------------------------------

/** Race a probe against a timeout. Errors and timeouts become generic strings (never secrets). */
async function withTimeout<T>(label: string, ms: number, probe: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      probe(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function toCheckResult(error: unknown): CheckResult {
  const message = error instanceof Error ? error.message : "unreachable"
  // Never leak connection details: only timeout signals pass through, everything else is generic.
  return { ok: false, error: message.includes("timeout") ? "timeout" : "unreachable" }
}

/** Database check goes through the shared @yourcrm/database client — never a raw connection. */
async function checkDatabase(url: string): Promise<CheckResult> {
  const start = Date.now()
  try {
    await withTimeout("database", READY_TIMEOUT_MS, () => getDb(url).execute(sql`SELECT 1`))
    return { ok: true, latencyMs: Date.now() - start }
  } catch (error) {
    return toCheckResult(error)
  }
}

async function checkRedis(url: string): Promise<CheckResult> {
  const start = Date.now()
  const redis = new Redis(url, { lazyConnect: true, connectTimeout: 1500, maxRetriesPerRequest: 0 })
  // Health probes must never crash the process on connection failure.
  redis.on("error", () => undefined)
  try {
    await withTimeout("redis", READY_TIMEOUT_MS, () => redis.ping())
    return { ok: true, latencyMs: Date.now() - start }
  } catch (error) {
    return toCheckResult(error)
  } finally {
    redis.disconnect()
  }
}

async function checkStorage(): Promise<CheckResult> {
  const start = Date.now()
  try {
    const env = getEnv()
    const svc = new StorageService(storageConfigFromEnv(env))
    // NOTE: StorageService.healthcheck() presigns without network I/O, so this
    // proves configuration/credentials are valid, not a live bucket round-trip.
    // A HeadBucket round-trip belongs in @yourcrm/storage (see runbook gap note).
    await withTimeout("storage", READY_TIMEOUT_MS, () => svc.healthcheck())
    return { ok: true, latencyMs: Date.now() - start }
  } catch (error) {
    return toCheckResult(error)
  }
}

export type QueueDepths = { ok: boolean; depth?: Record<string, number>; error?: string }

/**
 * Best-effort queue depth read straight from the BullMQ Redis keys
 * (`bull:<queue>:wait` + `:active` list lengths). Never throws; a failure
 * here is reported, not fatal, so observability can never break readiness.
 */
async function checkQueueDepths(url: string): Promise<QueueDepths> {
  const redis = new Redis(url, { lazyConnect: true, connectTimeout: 1500, maxRetriesPerRequest: 0 })
  redis.on("error", () => undefined)
  try {
    const depth = await withTimeout("queues", READY_TIMEOUT_MS, async () => {
      const out: Record<string, number> = {}
      for (const queue of KNOWN_QUEUES) {
        const [wait, active] = await Promise.all([
          redis.llen(`bull:${queue}:wait`),
          redis.llen(`bull:${queue}:active`),
        ])
        out[queue] = wait + active
      }
      return out
    })
    return { ok: true, depth }
  } catch {
    return { ok: false, error: "unreachable" }
  } finally {
    redis.disconnect()
  }
}

// ---------------------------------------------------------------------------
// Metrics: small hand-rolled Prometheus registry (no new dependencies)
// ---------------------------------------------------------------------------

type RequestKey = `${string} ${string} ${number}`

const requestCounts = new Map<RequestKey, number>()
const requestDurations = new Map<RequestKey, number[]>()
const depGauges = new Map<string, number>()
const queueGauges = new Map<string, number>()

const DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const
const PROCESS_START = Date.now()

/** Test helper: clear all recorded observations. */
export function resetMetrics(): void {
  requestCounts.clear()
  requestDurations.clear()
  depGauges.clear()
  queueGauges.clear()
}

function setDepGauge(name: string, check: CheckResult): void {
  depGauges.set(`${name}_up`, check.ok ? 1 : 0)
  if (check.latencyMs !== undefined) depGauges.set(`${name}_latency_ms`, check.latencyMs)
}

/** `METRICS_ENABLED=1|true` exposes /metrics. Default off: scrapers opt in, the internet opts out. */
export function isMetricsEnabled(): boolean {
  const raw = (process.env.METRICS_ENABLED ?? "").toLowerCase().trim()
  return raw === "1" || raw === "true" || raw === "yes"
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")
}

/** Render the registry in Prometheus text exposition format. */
export function renderMetrics(): string {
  const lines: string[] = []

  lines.push("# HELP yourcrm_http_requests_total Total HTTP requests by route and status.")
  lines.push("# TYPE yourcrm_http_requests_total counter")
  for (const [key, count] of [...requestCounts.entries()].sort()) {
    const sep1 = key.indexOf(" ")
    const sep2 = key.lastIndexOf(" ")
    const method = key.slice(0, sep1)
    const route = key.slice(sep1 + 1, sep2)
    const status = key.slice(sep2 + 1)
    lines.push(
      `yourcrm_http_requests_total{method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${status}"} ${count}`,
    )
  }

  lines.push("# HELP yourcrm_http_request_duration_ms HTTP request duration in milliseconds.")
  lines.push("# TYPE yourcrm_http_request_duration_ms histogram")
  for (const [key, samples] of [...requestDurations.entries()].sort()) {
    const sep1 = key.indexOf(" ")
    const sep2 = key.lastIndexOf(" ")
    const method = key.slice(0, sep1)
    const route = key.slice(sep1 + 1, sep2)
    const status = key.slice(sep2 + 1)
    const labels = `method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${status}"`
    const sorted = [...samples].sort((a, b) => a - b)
    let cumulative = 0
    for (const bucket of DURATION_BUCKETS_MS) {
      while (cumulative < sorted.length && (sorted[cumulative] ?? Infinity) <= bucket) {
        cumulative += 1
      }
      lines.push(`yourcrm_http_request_duration_ms_bucket{${labels},le="${bucket}"} ${cumulative}`)
    }
    lines.push(`yourcrm_http_request_duration_ms_bucket{${labels},le="+Inf"} ${sorted.length}`)
    const sum = sorted.reduce((acc, v) => acc + v, 0)
    lines.push(`yourcrm_http_request_duration_ms_sum{${labels}} ${sum}`)
    lines.push(`yourcrm_http_request_duration_ms_count{${labels}} ${sorted.length}`)
  }

  lines.push(
    "# HELP yourcrm_dependency_up Last readiness result per dependency (1 = ok, 0 = down).",
  )
  lines.push("# TYPE yourcrm_dependency_up gauge")
  for (const [name, value] of [...depGauges.entries()].sort()) {
    if (name.endsWith("_up")) {
      lines.push(`yourcrm_dependency_up{name="${escapeLabel(name.slice(0, -3))}"} ${value}`)
    }
  }
  lines.push("# HELP yourcrm_dependency_latency_ms Last readiness latency per dependency.")
  lines.push("# TYPE yourcrm_dependency_latency_ms gauge")
  for (const [name, value] of [...depGauges.entries()].sort()) {
    if (name.endsWith("_latency_ms")) {
      lines.push(
        `yourcrm_dependency_latency_ms{name="${escapeLabel(name.slice(0, -"_latency_ms".length))}"} ${value}`,
      )
    }
  }

  lines.push("# HELP yourcrm_queue_depth Best-effort BullMQ waiting+active jobs per queue.")
  lines.push("# TYPE yourcrm_queue_depth gauge")
  for (const [queue, depth] of [...queueGauges.entries()].sort()) {
    lines.push(`yourcrm_queue_depth{queue="${escapeLabel(queue)}"} ${depth}`)
  }

  lines.push("# HELP yourcrm_process_uptime_seconds Seconds since the API process started.")
  lines.push("# TYPE yourcrm_process_uptime_seconds gauge")
  lines.push(`yourcrm_process_uptime_seconds ${Math.floor((Date.now() - PROCESS_START) / 1000)}`)

  lines.push("# HELP yourcrm_process_memory_bytes Resident/set memory of the API process.")
  lines.push("# TYPE yourcrm_process_memory_bytes gauge")
  const mem = process.memoryUsage()
  for (const [kind, bytes] of Object.entries(mem)) {
    lines.push(`yourcrm_process_memory_bytes{kind="${kind}"} ${bytes}`)
  }

  lines.push(
    "# HELP yourcrm_db_pool_max_connections Configured postgres pool size (see database client).",
  )
  lines.push("# TYPE yourcrm_db_pool_max_connections gauge")
  lines.push("yourcrm_db_pool_max_connections 10")

  return `${lines.join("\n")}\n`
}

/**
 * Records request count + duration by route and status. Mounted globally in
 * app.ts; safe to leave on when /metrics is disabled (memory-bounded: one
 * entry per method/route/status triple plus capped duration samples).
 */
const MAX_SAMPLES_PER_KEY = 1024

export function metricsMiddleware() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const start = Date.now()
    await next()
    const method = c.req.method
    const route = c.req.routePath ?? c.req.path
    const status = c.res.status
    const key: RequestKey = `${method} ${route} ${status}`
    requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1)
    const samples = requestDurations.get(key) ?? []
    if (samples.length < MAX_SAMPLES_PER_KEY) samples.push(Date.now() - start)
    requestDurations.set(key, samples)
  })
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function envelope(
  c: { get: (key: "requestId") => string },
  status: "ok" | "degraded",
  checks: Record<string, CheckResult | (QueueDepths & { ok: boolean })>,
) {
  return {
    status,
    version: API_VERSION,
    requestId: c.get("requestId") ?? undefined,
    checks,
    time: new Date().toISOString(),
  }
}

/**
 * GET /health — cheap liveness probe. Touches NO dependency (no DB, Redis, or
 * S3 calls) so load balancers and the web status card get an answer even
 * during an outage. Shape matches the original endpoint: { status, version,
 * requestId, checks, time } with the same check keys; per-dependency truth
 * lives at /ready.
 */
export function healthRoutes() {
  const app = new Hono<AppEnv>()

  app.get("/", (c) => {
    const note = "liveness only — live dependency status at /ready"
    return c.json(
      envelope(c, "ok", {
        database: { ok: true, note },
        redis: { ok: true, note },
        storage: { ok: true, note },
        // Worker reachability is reported by the worker itself (Phase 0:
        // verified manually via `bun run dev` + Redis ping).
        worker: { ok: true, note: "see apps/worker" },
      }),
    )
  })

  return app
}

/**
 * GET /ready — readiness probe. Checks Postgres, Redis and S3/MinIO with a
 * short timeout, in parallel. Always answers 200 with per-dependency status;
 * degrades (`status: "degraded"`) instead of throwing when something is down.
 */
export function readyRoutes() {
  const app = new Hono<AppEnv>()

  app.get("/", async (c) => {
    const env = getEnv()
    const [database, redis, storage, queues] = await Promise.all([
      checkDatabase(env.DATABASE_URL),
      checkRedis(env.REDIS_URL),
      checkStorage(),
      checkQueueDepths(env.REDIS_URL),
    ])

    setDepGauge("database", database)
    setDepGauge("redis", redis)
    setDepGauge("storage", storage)
    if (queues.ok && queues.depth) {
      for (const [queue, depth] of Object.entries(queues.depth)) queueGauges.set(queue, depth)
    }

    const allOk = database.ok && redis.ok && storage.ok && queues.ok
    return c.json(
      envelope(c, allOk ? "ok" : "degraded", {
        database,
        redis,
        storage,
        worker: { ok: true, note: "see apps/worker" } as CheckResult,
        queues: {
          ok: queues.ok,
          ...(queues.depth ? { depth: queues.depth } : {}),
          ...(queues.error ? { error: queues.error } : {}),
        },
      }),
    )
  })

  return app
}

/**
 * GET /metrics — Prometheus text exposition. Gated behind METRICS_ENABLED
 * (default off); disabled answers 404 so the endpoint is never public
 * by accident. See docs/operations.md.
 */
export function metricsRoutes() {
  const app = new Hono<AppEnv>()

  app.get("/", (c) => {
    if (!isMetricsEnabled()) {
      return c.json(
        {
          error: {
            code: "NOT_FOUND",
            message: "No route for GET /metrics",
            requestId: c.get("requestId") ?? undefined,
          },
        },
        404,
      )
    }
    return c.text(renderMetrics(), 200, { "content-type": "text/plain; version=0.0.4" })
  })

  return app
}
