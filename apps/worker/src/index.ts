import { loadEnv } from "@yourcrm/config"
import { closeRedis, getRedis } from "./redis"
import { closeQueues } from "./queues"
import { createWorker } from "./worker"

// Validate env at startup (fail fast on bad config).
loadEnv()

const redis = getRedis()
redis.once("ready", () => {
  console.log(JSON.stringify({ level: "info", msg: "worker_redis_ready" }))
})

const worker = createWorker()
console.log(JSON.stringify({ level: "info", msg: "worker_started", queues: ["yourcrm-default"] }))

async function shutdown(signal: string): Promise<void> {
  console.log(JSON.stringify({ level: "info", msg: "worker_shutdown", signal }))
  await worker.close()
  await closeQueues()
  await closeRedis()
  process.exit(0)
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))
