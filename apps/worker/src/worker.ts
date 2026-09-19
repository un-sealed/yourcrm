import { Worker, type Job } from "bullmq"
import { getRedis } from "./redis"
import { QueueNames } from "./queues"
import { runExampleJob } from "./jobs/example"
import { AUTOMATION_RUN_JOB_NAME, runAutomationJob } from "./jobs/automation"
import { CAMPAIGN_SEND_BATCH_JOB_NAME, runCampaignBatchJob } from "./jobs/campaigns"
import { SEQUENCE_STEP_JOB_NAME, runSequenceStepJob } from "./jobs/sequences"
import { WEBHOOK_DELIVERY_JOB_NAME, runWebhookDeliveryJob } from "./jobs/webhooks"

/**
 * Job registration pattern: one named handler per job in `./jobs/*`,
 * dispatched by `jobName`. Later agents add handlers here + enqueue via
 * `getQueue(QueueNames.X).add(jobName, payload)`.
 */
export const JobHandlers = {
  "example.ping": runExampleJob,
  [AUTOMATION_RUN_JOB_NAME]: runAutomationJob,
  [CAMPAIGN_SEND_BATCH_JOB_NAME]: runCampaignBatchJob,
  [SEQUENCE_STEP_JOB_NAME]: runSequenceStepJob,
  [WEBHOOK_DELIVERY_JOB_NAME]: runWebhookDeliveryJob,
} as const

export type JobName = keyof typeof JobHandlers

export function createWorker(): Worker {
  const connection = getRedis()
  const worker = new Worker(
    QueueNames.Default,
    async (job: Job) => {
      const start = Date.now()
      const handler = (
        JobHandlers as Record<string, (data: unknown) => Promise<unknown> | unknown>
      )[job.name]
      if (!handler) throw new Error(`Unknown job: ${job.name} (dead-lettered after retries)`)
      const result = await handler(job.data)
      console.log(
        JSON.stringify({
          level: "info",
          msg: "job_completed",
          job: job.name,
          id: job.id,
          durationMs: Date.now() - start,
        }),
      )
      return result
    },
    {
      connection,
      concurrency: 5,
      limiter: { max: 50, duration: 1_000 },
    },
  )

  worker.on("failed", (job, err) => {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "job_failed",
        job: job?.name,
        id: job?.id,
        err: String(err),
      }),
    )
  })

  return worker
}
