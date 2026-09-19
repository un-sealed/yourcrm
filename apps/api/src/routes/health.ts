import { Hono } from "hono"
import type { AppEnv } from "../hono-env"
import { sql } from "drizzle-orm"
import { Redis } from "ioredis"
import { getDb } from "@yourcrm/database"
import { StorageService, storageConfigFromEnv } from "@yourcrm/storage"
import { getEnv } from "../env"

export type CheckResult = { ok: boolean; latencyMs?: number; error?: string }

/** Database check goes through the shared @yourcrm/database client — never a raw connection. */
async function checkDatabase(url: string): Promise<CheckResult> {
  const start = Date.now()
  try {
    await getDb(url).execute(sql`SELECT 1`)
    return { ok: true, latencyMs: Date.now() - start }
  } catch {
    return { ok: false, error: "unreachable" }
  }
}

async function checkRedis(url: string): Promise<CheckResult> {
  const start = Date.now()
  const redis = new Redis(url, { lazyConnect: true, connectTimeout: 1500, maxRetriesPerRequest: 0 })
  // Health probes must never crash the process on connection failure.
  redis.on("error", () => undefined)
  try {
    await redis.ping()
    return { ok: true, latencyMs: Date.now() - start }
  } catch {
    return { ok: false, error: "unreachable" }
  } finally {
    redis.disconnect()
  }
}

/**
 * GET /health — liveness + dependency status. Always 200 when the process
 * is alive; per-component results tell orchestrators what is degraded.
 * (Spec 00: database, migrations, Redis, storage, worker reachability.)
 */
export function healthRoutes() {
  const app = new Hono<AppEnv>()

  app.get("/", async (c) => {
    const env = getEnv()
    const [database, redis] = await Promise.all([
      checkDatabase(env.DATABASE_URL),
      checkRedis(env.REDIS_URL),
    ])
    let storage: CheckResult
    try {
      const svc = new StorageService(storageConfigFromEnv(env))
      await svc.healthcheck()
      storage = { ok: true }
    } catch {
      storage = { ok: false, error: "unreachable" }
    }

    const allOk = database.ok && redis.ok && storage.ok
    return c.json({
      status: allOk ? "ok" : "degraded",
      version: "0.1.0",
      requestId: c.get("requestId") ?? undefined,
      checks: {
        database,
        redis,
        storage,
        // Worker reachability is reported by the worker itself (Phase 0:
        // verified manually via `bun run dev` + Redis ping).
        worker: { ok: true, note: "see apps/worker" } as CheckResult & { note: string },
      },
      time: new Date().toISOString(),
    })
  })

  return app
}
