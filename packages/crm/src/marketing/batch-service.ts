import type { MarketingBatchServiceDeps, MarketingCampaignRecipientRecord } from "./types"

export type MarketingSendBatchResult = {
  claimed: number
  sent: number
  failed: number
  /** Rows still `pending` after this batch — tells the worker whether to requeue. */
  remainingPending: number
}

/**
 * Batch-sending orchestration (spec 24-marketing, P0) — the code the worker
 * job (`apps/worker/src/jobs/campaigns.ts`) calls per BullMQ batch. Never
 * called inline from an HTTP request (`campaigns-service.ts`'s `send()`
 * only enqueues); never imports BullMQ (that seam is entirely the worker
 * job's job).
 *
 * IDEMPOTENCY ACROSS A RETRY: `deps.recipients.claimBatch` is the
 * claim-before-send step (`UPDATE ... WHERE status = 'pending' ... FOR
 * UPDATE SKIP LOCKED` in the repository). A retried/duplicated BullMQ
 * delivery of the SAME job calls `claimBatch` again; every row this
 * function already moved to `sending`/`sent`/`failed` is invisible to that
 * `WHERE status = 'pending'`, so the retry claims a disjoint (possibly
 * empty) set and never re-sends a recipient. No idempotency key or
 * dedupe table is needed — it falls out of the claim predicate.
 */
export function createMarketingBatchService(deps: MarketingBatchServiceDeps) {
  async function sendBatch(
    workspaceId: string,
    campaignId: string,
    batchSize: number,
    correlationId?: string,
  ): Promise<MarketingSendBatchResult> {
    const campaign = await deps.campaigns.findById(workspaceId, campaignId)
    if (!campaign) {
      return { claimed: 0, sent: 0, failed: 0, remainingPending: 0 }
    }

    const claimed: MarketingCampaignRecipientRecord[] = await deps.recipients.claimBatch({
      workspaceId,
      campaignId,
      limit: batchSize,
    })

    let sent = 0
    let failed = 0
    for (const recipient of claimed) {
      const result = await deps.sender.send({
        workspaceId,
        campaignId,
        personId: recipient.personId,
        subject: String(campaign.subject ?? ""),
        bodyHtml: (campaign.bodyHtml as string | null | undefined) ?? null,
        bodyText: (campaign.bodyText as string | null | undefined) ?? null,
      })
      if (result.outcome === "sent") {
        await deps.recipients.markSent(recipient.id, result.emailMessageId)
        sent += 1
      } else {
        await deps.recipients.markFailed(recipient.id, result.reason)
        failed += 1
      }
    }

    if (sent > 0 || failed > 0) {
      await deps.campaigns.incrementCounters(workspaceId, campaignId, {
        sentCount: sent,
        failedCount: failed,
      })
    }

    const counts = await deps.recipients.countsByStatus(workspaceId, campaignId)
    const remainingPending = counts.pending ?? 0

    // Only a campaign actively `sending` transitions to `sent` here — once
    // per campaign, whether this batch claimed the last rows or (an empty
    // segment) claimed nothing at all.
    if (remainingPending === 0 && campaign.status === "sending") {
      const after = await deps.campaigns.setStatus(workspaceId, campaignId, "sent", {
        sentAt: new Date(),
      })
      await deps.audit({
        workspaceId,
        actorId: null,
        action: "sent",
        object: "campaign",
        recordId: campaignId,
        before: campaign,
        after: after ?? undefined,
        correlationId,
        source: "automation",
      })
    }

    return { claimed: claimed.length, sent, failed, remainingPending }
  }

  return { sendBatch }
}

export type MarketingBatchService = ReturnType<typeof createMarketingBatchService>
