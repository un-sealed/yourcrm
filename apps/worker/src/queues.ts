import { Queue, type JobsOptions } from "bullmq"
import { getRedis } from "./redis"

/**
 * Queue abstraction — domain code enqueues through `getQueue()` + named
 * job helpers, never by constructing BullMQ primitives directly. This keeps
 * the Temporal migration path (spec 01) to one file.
 */

const queues = new Map<string, Queue>()

export function getQueue(name: string): Queue {
  const existing = queues.get(name)
  if (existing) return existing
  const queue = new Queue(name, {
    connection: getRedis(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { count: 1_000 },
      removeOnFail: { count: 5_000 },
    } satisfies JobsOptions,
  })
  queues.set(name, queue)
  return queue
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()))
  queues.clear()
}

export const QueueNames = {
  Default: "yourcrm-default",
  Communications: "yourcrm-communications",
  Automation: "yourcrm-automation",
  Ai: "yourcrm-ai",
} as const
