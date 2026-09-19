import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"

/**
 * Marketing / Campaigns module ports (spec 24-marketing, P0).
 *
 * `@yourcrm/crm` has no database dependency, so the service talks to these
 * structural ports instead; `apps/api/src/routes/modules/marketing.ts`
 * adapts `packages/database/src/repositories/marketing-repository.ts` and
 * `writeAudit` to them, and hermetic tests satisfy them with in-memory
 * fakes. Same pattern as the `people` reference module.
 *
 * FILTER MODEL: `MarketingFilterTree` is a segment's audience definition —
 * the exact `@yourcrm/ui` FilterBuilder encoding, restated here exactly
 * like `packages/crm/src/reports/types.ts` restates `ReportFilterTree` and
 * `packages/database/src/schema/marketing.ts` restates it again for
 * persistence. There is exactly ONE filter model in the product; a
 * marketing segment IS a saved filter over people (reusing the reports
 * engine's `person` object, see the repository). Keep all three restatements
 * in step — never introduce a second model.
 *
 * SENDING: this module never imports BullMQ or an email transport. Sending
 * one recipient's email is `MarketingCampaignSenderPort.send()`, bound in
 * the worker composition root to the existing
 * `@yourcrm/crm/src/email` service's `sendMessage()` (which itself owns the
 * provider port) — see `apps/worker/src/jobs/campaigns.ts`.
 */

export type MarketingFilterCondition = {
  type: "condition"
  id: string
  field: string
  operator: string
  value?: unknown
}

export type MarketingFilterGroup = {
  type: "group"
  id: string
  combinator: "and" | "or"
  children: MarketingFilterNode[]
}

export type MarketingFilterNode = MarketingFilterCondition | MarketingFilterGroup

/** Root of a segment's stored filter is always a group (empty = match all). */
export type MarketingFilterTree = MarketingFilterGroup

export const MARKETING_CAMPAIGN_STATUSES = [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "cancelled",
] as const

export type MarketingCampaignStatus = (typeof MARKETING_CAMPAIGN_STATUSES)[number]

/* -------------------------------- records ------------------------------- */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type MarketingSegmentRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  filter: MarketingFilterTree
}

export type MarketingCampaignRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  segmentId: string
  status: string
  subject: string
  bodyHtml?: string | null
  bodyText?: string | null
  recipientCount: number
  sentCount: number
  failedCount: number
}

export type MarketingConsentRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  personId: string
  marketingConsent: boolean
  unsubscribedAt?: string | Date | null
  unsubscribeToken: string
}

export type MarketingCampaignRecipientRecord = Record<string, unknown> & {
  id: string
  campaignId: string
  personId: string
  status: string
}

/* -------------------------------- queries -------------------------------- */

export type MarketingListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
}

export type MarketingSegmentListResult = {
  data: MarketingSegmentRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type MarketingCampaignListQuery = MarketingListQuery & { status?: string }

export type MarketingCampaignListResult = {
  data: MarketingCampaignRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

/* --------------------------------- stores -------------------------------- */

export type MarketingSegmentsStore = {
  list(workspaceId: string, query: MarketingListQuery): Promise<MarketingSegmentListResult>
  findById(workspaceId: string, id: string): Promise<MarketingSegmentRecord | null>
  create(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<MarketingSegmentRecord>
  update(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<MarketingSegmentRecord | null>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  restore(workspaceId: string, id: string): Promise<void>
  /** Live count of people currently matching the filter (preview only). */
  evaluate(workspaceId: string, filter: MarketingFilterTree): Promise<{ count: number }>
  recordEvaluation(workspaceId: string, id: string, memberCount: number): Promise<void>
}

export type MarketingCampaignsStore = {
  list(workspaceId: string, query: MarketingCampaignListQuery): Promise<MarketingCampaignListResult>
  findById(workspaceId: string, id: string): Promise<MarketingCampaignRecord | null>
  create(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<MarketingCampaignRecord>
  update(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<MarketingCampaignRecord | null>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  setStatus(
    workspaceId: string,
    id: string,
    status: string,
    extra?: { scheduledAt?: Date | null; sentAt?: Date | null },
  ): Promise<MarketingCampaignRecord | null>
  setCounters(
    workspaceId: string,
    id: string,
    counters: Partial<
      Pick<MarketingCampaignRecord, "recipientCount" | "sentCount" | "failedCount">
    >,
  ): Promise<void>
  incrementCounters(
    workspaceId: string,
    id: string,
    delta: { sentCount?: number; failedCount?: number },
  ): Promise<void>
}

export type MarketingConsentStore = {
  findByPersonId(workspaceId: string, personId: string): Promise<MarketingConsentRecord | null>
  findByToken(token: string): Promise<MarketingConsentRecord | null>
  upsert(
    workspaceId: string,
    input: { personId: string; marketingConsent: boolean; source?: string },
    actorId?: string,
  ): Promise<MarketingConsentRecord>
  /** Token-authenticated (no session): possession of the token is the proof. */
  unsubscribeByToken(token: string): Promise<MarketingConsentRecord | null>
}

export type MarketingRecipientsStore = {
  /** Materialise eligible recipients (consent-filtered, in SQL) for a send. */
  prepareRecipients(params: {
    workspaceId: string
    campaignId: string
    segmentFilter: MarketingFilterTree
  }): Promise<{ inserted: number }>
  /** Claim-before-send: atomically move `pending` rows to `sending`. */
  claimBatch(params: {
    workspaceId: string
    campaignId: string
    limit: number
  }): Promise<MarketingCampaignRecipientRecord[]>
  markSent(
    id: string,
    emailMessageId: string | null,
  ): Promise<MarketingCampaignRecipientRecord | null>
  markFailed(id: string, reason: string): Promise<MarketingCampaignRecipientRecord | null>
  countsByStatus(workspaceId: string, campaignId: string): Promise<Record<string, number>>
}

/* --------------------------------- sending -------------------------------- */

export type MarketingRecipientSendResult =
  | { outcome: "sent"; emailMessageId: string | null }
  | { outcome: "failed"; reason: string }

export type MarketingCampaignSenderPort = {
  /**
   * Send one recipient's email. Implemented in the worker composition root:
   * resolves the person's address via the people repository, builds the
   * unsubscribe link from the recipient's consent token, and sends through
   * the existing `@yourcrm/crm/src/email` service's `sendMessage()` — this
   * module never talks to a transport or provider directly.
   */
  send(input: {
    workspaceId: string
    campaignId: string
    personId: string
    subject: string
    bodyHtml: string | null
    bodyText: string | null
  }): Promise<MarketingRecipientSendResult>
}

/** Enqueue seam for the FIRST batch of a send (worker owns batch-to-batch continuation). */
export type MarketingQueuePort = {
  enqueueCampaignBatch(request: {
    workspaceId: string
    campaignId: string
    batchSize: number
    correlationId?: string
  }): Promise<void>
}

/* -------------------------------- audit ---------------------------------- */

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type MarketingAuditInput = {
  workspaceId: string
  actorId?: string | null
  action: string
  object: string
  recordId?: string | null
  before?: unknown
  after?: unknown
  correlationId?: string | null
  source?: "user" | "automation" | "ai" | "integration" | "mcp"
}

export type MarketingServiceContext = ServiceContext
export type MarketingSegmentsServiceContext = ServiceContext
export type MarketingCampaignsServiceContext = ServiceContext
export type MarketingConsentServiceContext = ServiceContext
export type MarketingBatchServiceContext = ServiceContext

export type MarketingSegmentsServiceDeps = {
  store: MarketingSegmentsStore
  audit: AuditWriter<MarketingAuditInput>
  events?: EventEmitter
}

export type MarketingConsentServiceDeps = {
  store: MarketingConsentStore
  audit: AuditWriter<MarketingAuditInput>
  events?: EventEmitter
}

export type MarketingCampaignsServiceDeps = {
  campaigns: MarketingCampaignsStore
  segments: MarketingSegmentsStore
  recipients: MarketingRecipientsStore
  queue: MarketingQueuePort
  audit: AuditWriter<MarketingAuditInput>
  events?: EventEmitter
  /** Default recipients claimed per BullMQ batch (spec: "never inline"). */
  batchSize?: number
}

export type MarketingBatchServiceDeps = {
  campaigns: MarketingCampaignsStore
  recipients: MarketingRecipientsStore
  sender: MarketingCampaignSenderPort
  audit: AuditWriter<MarketingAuditInput>
  events?: EventEmitter
}
