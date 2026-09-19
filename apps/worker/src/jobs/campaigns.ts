import { z } from "zod"
import { getQueue, QueueNames } from "../queues"

/**
 * Campaign batch-send job (spec 24-marketing, P0).
 *
 * This is the worker half of the BullMQ seam: `campaigns-service.ts`'s
 * `send()` (in `@yourcrm/crm/src/marketing`) materialises the
 * consent-filtered recipient list and enqueues the FIRST batch; this
 * handler claims and sends one batch, then — same process, same package,
 * which already declares `bullmq` — self-enqueues the next one until no
 * `pending` rows remain. Domain code never imports BullMQ; this file is
 * where that seam lives, exactly like `automation.ts`.
 *
 * Like `automation.ts` and `import-export.ts`, the payload schema is
 * restated here rather than imported: this file is the process boundary,
 * and spec 01 requires a job to be a pure function of ITS OWN validated
 * input. The canonical contract (job name, payload shape) lives here since
 * `@yourcrm/marketing` has no separate queue-contract package yet — keep
 * this file and `campaigns-service.ts`'s `MarketingQueuePort` request shape
 * in step.
 *
 * WHY THE SENDER IS INJECTED
 * --------------------------
 * The actual batch-processing logic — claim-before-send, calling the email
 * service, recording per-recipient outcomes, flipping the campaign to
 * `sent` — lives in `@yourcrm/crm/src/marketing`'s `createMarketingBatchService`
 * (`sendBatch`). Wiring that service to live Postgres (the marketing
 * repository) and to `@yourcrm/crm/src/email`'s `sendMessage()` (the
 * existing email transport) is composition-root work that belongs in the
 * worker bootstrap (`apps/worker/src/index.ts`), which is out of this
 * agent's narrow file allowance (`jobs/campaigns.ts` +
 * a minimal registration in `worker.ts` only). Until the bootstrap calls
 * `registerCampaignBatchSender(...)`, the default throws loudly instead of
 * silently dropping a send — same failure shape as
 * `WorkflowRunnerNotBoundError` in `automation.ts`.
 *
 * THE THREE PROPERTIES, NOT WEAKENED BY THE TRANSPORT:
 *  - IDEMPOTENCY: claim-before-send (`UPDATE ... WHERE status = 'pending'
 *    ... FOR UPDATE SKIP LOCKED`, `marketing-repository.ts`) means a BullMQ
 *    retry of this exact job claims nothing already claimed/sent/failed —
 *    it cannot re-send a recipient. Retrying this job is safe by
 *    construction, same guarantee `automation.ts` documents for runs.
 *  - CONSENT: enforced before this job ever sees a recipient — see
 *    `marketing-repository.ts`'s `prepareRecipients`.
 *  - BOUNDED WORK: one job processes at most `batchSize` recipients, never
 *    the whole campaign inline.
 */

export const CAMPAIGN_SEND_BATCH_JOB_NAME = "campaign.send_batch"

export const campaignBatchJobPayloadSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  campaignId: z.string().min(1).max(128),
  batchSize: z.number().int().min(1).max(500),
  correlationId: z.string().max(64).optional(),
})

export type CampaignBatchJobPayload = z.infer<typeof campaignBatchJobPayloadSchema>

export type CampaignBatchJobResult = {
  claimed: number
  sent: number
  failed: number
  remainingPending: number
}

/** What the bootstrap binds: usually `batchService.sendBatch`. */
export type CampaignBatchSenderPort = (
  payload: CampaignBatchJobPayload,
) => Promise<CampaignBatchJobResult>

export class CampaignBatchSenderNotBoundError extends Error {
  readonly code = "CAMPAIGN_BATCH_SENDER_NOT_BOUND"
  constructor() {
    super(
      "no campaign batch sender is registered: call registerCampaignBatchSender() from the worker bootstrap",
    )
    this.name = "CampaignBatchSenderNotBoundError"
  }
}

const unboundSender: CampaignBatchSenderPort = async () => {
  throw new CampaignBatchSenderNotBoundError()
}

let sender: CampaignBatchSenderPort = unboundSender

export function registerCampaignBatchSender(next: CampaignBatchSenderPort): void {
  sender = next
}

/** Restores the unbound default (tests, and a clean shutdown). */
export function resetCampaignBatchSender(): void {
  sender = unboundSender
}

/**
 * Requeue port — separated from `getQueue(...).add(...)` so hermetic tests
 * (no live Redis) can stub the transport instead of mocking `bullmq`. The
 * real default below IS live BullMQ: unlike the sender, this one needs no
 * bootstrap wiring because `apps/worker` already declares `bullmq` and
 * already owns the queue seam (`../queues.ts`) — the same trust boundary
 * `automation.ts`'s job handler operates inside.
 */
export type CampaignBatchRequeuePort = (
  payload: CampaignBatchJobPayload,
  dedupeSuffix: string,
) => Promise<void>

const defaultRequeue: CampaignBatchRequeuePort = async (payload, dedupeSuffix) => {
  await getQueue(QueueNames.Communications).add(CAMPAIGN_SEND_BATCH_JOB_NAME, payload, {
    // Deterministic id keeps a redelivered "keep draining" enqueue from
    // piling up a second copy of the same continuation.
    jobId: `${CAMPAIGN_SEND_BATCH_JOB_NAME}:${payload.campaignId}:${dedupeSuffix}`,
  })
}

let requeue: CampaignBatchRequeuePort = defaultRequeue

/** Test-only seam: inject a fake requeuer instead of touching live Redis. */
export function registerCampaignBatchRequeuer(next: CampaignBatchRequeuePort): void {
  requeue = next
}

export function resetCampaignBatchRequeuer(): void {
  requeue = defaultRequeue
}

/**
 * Execute one queued batch. Retryable (claim-before-send makes the sender
 * idempotent), observable (JSON log with campaign/correlation ids) and
 * validated at run time as well as at enqueue. Self-enqueues the next
 * batch when recipients remain — the campaign keeps draining without a
 * human or the API re-triggering it.
 */
export async function runCampaignBatchJob(input: unknown): Promise<CampaignBatchJobResult> {
  const payload = campaignBatchJobPayloadSchema.parse(input)
  const start = Date.now()
  const result = await sender(payload)

  console.log(
    JSON.stringify({
      level: "info",
      msg: "campaign_batch_sent",
      job: CAMPAIGN_SEND_BATCH_JOB_NAME,
      workspaceId: payload.workspaceId,
      campaignId: payload.campaignId,
      claimed: result.claimed,
      sent: result.sent,
      failed: result.failed,
      remainingPending: result.remainingPending,
      durationMs: Date.now() - start,
      ...(payload.correlationId === undefined ? {} : { correlationId: payload.correlationId }),
    }),
  )

  if (result.remainingPending > 0) {
    await requeue(payload, String(start))
  }

  return result
}
