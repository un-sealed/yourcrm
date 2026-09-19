import type { BadgeTone, FilterFieldDef, FilterTree } from "@yourcrm/ui"

/** Marketing segment as returned by `GET /api/v1/marketing/segments` (envelope `data` item). */
export type MarketingSegment = {
  id: string
  workspaceId: string
  name: string
  description: string | null
  ownerId: string | null
  filter: FilterTree
  memberCount: number | null
  lastEvaluatedAt: string | null
  createdAt: string
  updatedAt: string
}

export type MarketingSegmentsListResponse = {
  data: MarketingSegment[]
  pagination: { nextCursor: string | null; limit: number }
}

export const MARKETING_CAMPAIGN_STATUSES = [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "cancelled",
] as const

export type MarketingCampaignStatus = (typeof MARKETING_CAMPAIGN_STATUSES)[number]

/** Campaign as returned by `GET /api/v1/marketing/campaigns` (envelope `data` item). */
export type MarketingCampaign = {
  id: string
  workspaceId: string
  name: string
  subject: string
  bodyHtml: string | null
  bodyText: string | null
  segmentId: string
  status: MarketingCampaignStatus
  scheduledAt: string | null
  sentAt: string | null
  connectionId: string | null
  recipientCount: number
  sentCount: number
  failedCount: number
  createdAt: string
  updatedAt: string
}

export type MarketingCampaignsListResponse = {
  data: MarketingCampaign[]
  pagination: { nextCursor: string | null; limit: number }
}

export const CAMPAIGN_STATUS_TONE: Record<MarketingCampaignStatus, BadgeTone> = {
  draft: "secondary",
  scheduled: "warning",
  sending: "warning",
  sent: "success",
  cancelled: "destructive",
}

export const CAMPAIGN_STATUS_LABEL: Record<MarketingCampaignStatus, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  sending: "Sending",
  sent: "Sent",
  cancelled: "Cancelled",
}

/**
 * The people fields a segment can filter on — the same allowlist as
 * `REPORT_OBJECTS.person` in
 * `packages/database/src/repositories/reports-repository.ts`, restated for
 * the web builder exactly like `apps/web/app/app/reports/types.ts` restates
 * its own object catalogue. A marketing segment IS a saved filter over
 * people; this is the one `FilterBuilder` field list for that filter.
 */
export const MARKETING_SEGMENT_FILTER_FIELDS: FilterFieldDef[] = [
  { name: "firstName", label: "First name", type: "text" },
  { name: "lastName", label: "Last name", type: "text" },
  { name: "title", label: "Job title", type: "text" },
  {
    name: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "active", label: "Active" },
      { value: "archived", label: "Archived" },
    ],
  },
  {
    name: "preferredChannel",
    label: "Preferred channel",
    type: "select",
    options: [
      { value: "email", label: "Email" },
      { value: "phone", label: "Phone" },
      { value: "sms", label: "SMS" },
      { value: "whatsapp", label: "WhatsApp" },
    ],
  },
  { name: "companyId", label: "Company", type: "text" },
  { name: "ownerId", label: "Owner", type: "text" },
  { name: "createdAt", label: "Created", type: "date" },
  { name: "updatedAt", label: "Updated", type: "date" },
]

export type { FilterTree }
