import { Redis } from "ioredis"

let redis: Redis | null = null

/** Shared Redis connection (BullMQ-compatible). Closed on shutdown. */
export function getRedis(url?: string): Redis {
  if (redis) return redis
  redis = new Redis(url ?? process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  })
  redis.on("error", (err) => {
    console.error(JSON.stringify({ level: "error", msg: "redis_error", err: String(err) }))
  })
  return redis
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    redis.disconnect()
    redis = null
  }
}
