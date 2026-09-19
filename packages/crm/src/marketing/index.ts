/**
 * Marketing / Campaigns module (spec 24-marketing, P0).
 *
 * Every export is prefixed `Marketing`/`marketing` on purpose: `../index.ts`
 * is a single generated `export *` barrel across every CRM module, so a
 * generic name (`Campaign`, `Segment`, `Consent`) would collide with a
 * sibling module.
 */

export { MarketingSegmentNotFoundError, createMarketingSegmentsService } from "./segments-service"
export type { MarketingSegmentsService } from "./segments-service"

export { MarketingConsentNotFoundError, createMarketingConsentService } from "./consent-service"
export type { MarketingConsentService } from "./consent-service"

export {
  MarketingCampaignNotFoundError,
  MarketingCampaignStateError,
  MarketingSegmentNotFoundForCampaignError,
  createMarketingCampaignsService,
} from "./campaigns-service"
export type { MarketingCampaignsService } from "./campaigns-service"

export { createMarketingBatchService } from "./batch-service"
export type { MarketingBatchService, MarketingSendBatchResult } from "./batch-service"

export {
  createMarketingCampaignSchema,
  createMarketingSegmentSchema,
  marketingCampaignQuerySchema,
  marketingCampaignSchema,
  marketingCampaignStatuses,
  marketingConsentSchema,
  marketingFilterOperators,
  marketingFilterOperatorSchema,
  marketingFilterTreeSchema,
  marketingSegmentQuerySchema,
  marketingSegmentSchema,
  scheduleMarketingCampaignSchema,
  unsubscribeByTokenSchema,
  updateMarketingCampaignSchema,
  updateMarketingSegmentSchema,
  upsertMarketingConsentSchema,
} from "./schemas"
export type {
  CreateMarketingCampaignInput,
  CreateMarketingSegmentInput,
  MarketingCampaignDto,
  MarketingCampaignQuery,
  MarketingConsentDto,
  MarketingSegmentDto,
  MarketingSegmentQuery,
  ScheduleMarketingCampaignInput,
  UnsubscribeByTokenInput,
  UpdateMarketingCampaignInput,
  UpdateMarketingSegmentInput,
  UpsertMarketingConsentInput,
} from "./schemas"

export { MARKETING_CAMPAIGN_STATUSES } from "./types"
export type {
  MarketingAuditInput,
  MarketingBatchServiceContext,
  MarketingBatchServiceDeps,
  MarketingCampaignListQuery,
  MarketingCampaignListResult,
  MarketingCampaignRecipientRecord,
  MarketingCampaignRecord,
  MarketingCampaignSenderPort,
  MarketingCampaignStatus,
  MarketingCampaignsServiceContext,
  MarketingCampaignsServiceDeps,
  MarketingCampaignsStore,
  MarketingConsentRecord,
  MarketingConsentServiceContext,
  MarketingConsentServiceDeps,
  MarketingConsentStore,
  MarketingFilterCondition,
  MarketingFilterGroup,
  MarketingFilterNode,
  MarketingFilterTree,
  MarketingListQuery,
  MarketingQueuePort,
  MarketingRecipientSendResult,
  MarketingRecipientsStore,
  MarketingSegmentListResult,
  MarketingSegmentRecord,
  MarketingSegmentsServiceContext,
  MarketingSegmentsServiceDeps,
  MarketingSegmentsStore,
  MarketingServiceContext,
} from "./types"
