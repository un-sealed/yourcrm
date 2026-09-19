import { afterEach, describe, expect, test } from "bun:test"
import {
  CAMPAIGN_SEND_BATCH_JOB_NAME,
  CampaignBatchSenderNotBoundError,
  campaignBatchJobPayloadSchema,
  registerCampaignBatchRequeuer,
  registerCampaignBatchSender,
  resetCampaignBatchRequeuer,
  resetCampaignBatchSender,
  runCampaignBatchJob,
  type CampaignBatchJobPayload,
  type CampaignBatchJobResult,
} from "./campaigns"
import { JobHandlers } from "../worker"

const payload: CampaignBatchJobPayload = {
  workspaceId: "ws_1",
  campaignId: "camp_1",
  batchSize: 50,
}

afterEach(() => {
  resetCampaignBatchSender()
  resetCampaignBatchRequeuer()
})

describe("worker/campaigns", () => {
  test("the handler is registered under the queue seam's job name", () => {
    expect(Object.keys(JobHandlers)).toContain(CAMPAIGN_SEND_BATCH_JOB_NAME)
    expect(CAMPAIGN_SEND_BATCH_JOB_NAME).toBe("campaign.send_batch")
  })

  test("the payload is validated at run time, not just at enqueue", async () => {
    expect(campaignBatchJobPayloadSchema.parse(payload).campaignId).toBe("camp_1")
    await expect(runCampaignBatchJob({ ...payload, campaignId: "" })).rejects.toThrow()
    await expect(runCampaignBatchJob({ nope: true })).rejects.toThrow()
  })

  test("an unbound sender fails loudly instead of dropping the batch", async () => {
    await expect(runCampaignBatchJob(payload)).rejects.toThrow(CampaignBatchSenderNotBoundError)
  })

  test("a bound sender receives the validated payload", async () => {
    const seen: CampaignBatchJobPayload[] = []
    registerCampaignBatchSender(async (input) => {
      seen.push(input)
      return { claimed: 2, sent: 2, failed: 0, remainingPending: 0 }
    })
    const result = await runCampaignBatchJob(payload)
    expect(result).toEqual({ claimed: 2, sent: 2, failed: 0, remainingPending: 0 })
    expect(seen[0]?.campaignId).toBe("camp_1")
  })

  test("more pending recipients => the next batch is requeued (no live Redis needed: transport is stubbed)", async () => {
    registerCampaignBatchSender(async () => ({
      claimed: 50,
      sent: 50,
      failed: 0,
      remainingPending: 25,
    }))
    const requeued: CampaignBatchJobPayload[] = []
    registerCampaignBatchRequeuer(async (nextPayload) => {
      requeued.push(nextPayload)
    })
    await runCampaignBatchJob(payload)
    expect(requeued).toHaveLength(1)
    expect(requeued[0]?.campaignId).toBe("camp_1")
  })

  test("zero pending recipients left => nothing is requeued", async () => {
    registerCampaignBatchSender(async () => ({
      claimed: 10,
      sent: 10,
      failed: 0,
      remainingPending: 0,
    }))
    let requeueCalls = 0
    registerCampaignBatchRequeuer(async () => {
      requeueCalls += 1
    })
    await runCampaignBatchJob(payload)
    expect(requeueCalls).toBe(0)
  })

  test("IDEMPOTENCY: a retried delivery of the same job is safe because the sender's claim is atomic", async () => {
    // The job handler itself has no dedupe logic — idempotency comes from
    // `claimBatch`'s `WHERE status = 'pending' ... FOR UPDATE SKIP LOCKED`
    // (proven in `packages/database/src/repositories/marketing-repository.test.ts`
    // and `packages/crm/src/marketing/service.test.ts`). Here we prove the
    // job handler faithfully re-delegates on a retry rather than skipping
    // it or caching a stale result — a fake sender that behaves exactly
    // like the real claim-before-send store (second call claims nothing).
    let callCount = 0
    registerCampaignBatchSender(async (): Promise<CampaignBatchJobResult> => {
      callCount += 1
      const firstDelivery = callCount === 1
      return firstDelivery
        ? { claimed: 5, sent: 5, failed: 0, remainingPending: 0 }
        : { claimed: 0, sent: 0, failed: 0, remainingPending: 0 }
    })
    const first = await runCampaignBatchJob(payload)
    const retry = await runCampaignBatchJob(payload)
    expect(first.sent).toBe(5)
    expect(retry.sent).toBe(0)
    expect(retry.claimed).toBe(0)
    expect(callCount).toBe(2)
  })
})
