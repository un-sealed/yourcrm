import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { baseColumns, ownerColumn, workspaceColumn } from "./base"

/**
 * Marketing / Campaigns module tables (spec 24-marketing, P0).
 * Migration `0290_marketing.sql`.
 *
 * A `marketing_segment` is a NAMED FILTER TREE over `people`, evaluated at
 * send time — never materialised as membership rows. A `campaign` targets
 * one segment and, once sent, owns one `campaign_recipient` row per person
 * it is allowed to email.
 *
 * CONSENT: `marketing_consents` is durable, per-person state independent of
 * any one campaign — an unsubscribe must hold across every FUTURE campaign.
 * `prepareRecipients` (marketing-repository.ts) joins it into the INSERT so
 * a person lacking consent or already unsubscribed never gets a
 * `campaign_recipients` row; there is no post-hoc filter to bypass.
 *
 * CROSS-MODULE LINKS: `person_id` and `owner_id` are PLAIN uuid columns with
 * an index and NO foreign key — `people`/`users` belong to other module
 * agents (same rule as `people.company_id`, 0010_people.sql). FKs here only
 * point at tables this migration creates (`marketing_segments`, `campaigns`).
 */

/**
 * Persistence mirror of the `FilterTree` exported by `@yourcrm/ui`
 * (`packages/ui/src/filter-builder.tsx`) — restated exactly like
 * `schema/reports.ts`'s `ReportFilterTree`. There is exactly ONE filter
 * model in the product; `@yourcrm/database` is infrastructure and must not
 * import UI, so the shape is restated here and validated structurally at
 * the repository boundary. Named distinctively (`MarketingFilter*`, not
 * `Filter*`) because this file lands in the single generated schema barrel
 * alongside `reports.ts`'s own restatement.
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

/** Root of a stored segment filter is always a group (empty = match all). */
export type MarketingFilterTree = MarketingFilterGroup

export const MARKETING_CAMPAIGN_STATUSES = [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "cancelled",
] as const

export type MarketingCampaignStatus = (typeof MARKETING_CAMPAIGN_STATUSES)[number]

export function isMarketingCampaignStatus(value: unknown): value is MarketingCampaignStatus {
  return (
    typeof value === "string" && (MARKETING_CAMPAIGN_STATUSES as readonly string[]).includes(value)
  )
}

export const MARKETING_RECIPIENT_STATUSES = ["pending", "sending", "sent", "failed"] as const

export type MarketingRecipientStatus = (typeof MARKETING_RECIPIENT_STATUSES)[number]

export function isMarketingRecipientStatus(value: unknown): value is MarketingRecipientStatus {
  return (
    typeof value === "string" && (MARKETING_RECIPIENT_STATUSES as readonly string[]).includes(value)
  )
}

export const marketingSegments = pgTable(
  "marketing_segments",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    filter: jsonb("filter")
      .$type<MarketingFilterTree>()
      .notNull()
      .default(sql`'{"type":"group","id":"root","combinator":"and","children":[]}'::jsonb`),
    memberCount: integer("member_count"),
    lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
  },
  (t) => [
    index("marketing_segments_workspace_idx").on(t.workspaceId),
    uniqueIndex("marketing_segments_workspace_name_uidx")
      .on(t.workspaceId, sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
)

export type MarketingSegment = typeof marketingSegments.$inferSelect
export type NewMarketingSegment = typeof marketingSegments.$inferInsert

export const marketingConsents = pgTable(
  "marketing_consents",
  {
    ...baseColumns,
    ...workspaceColumn,
    personId: uuid("person_id").notNull(),
    marketingConsent: boolean("marketing_consent").notNull().default(false),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    unsubscribeToken: uuid("unsubscribe_token").notNull().defaultRandom(),
    consentSource: varchar("consent_source", { length: 32 }).notNull().default("manual"),
    lastConsentEventAt: timestamp("last_consent_event_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("marketing_consents_workspace_idx").on(t.workspaceId),
    uniqueIndex("marketing_consents_workspace_person_uidx")
      .on(t.workspaceId, t.personId)
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex("marketing_consents_token_uidx").on(t.unsubscribeToken),
  ],
)

export type MarketingConsent = typeof marketingConsents.$inferSelect
export type NewMarketingConsent = typeof marketingConsents.$inferInsert

export const campaigns = pgTable(
  "campaigns",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    name: varchar("name", { length: 255 }).notNull(),
    subject: varchar("subject", { length: 998 }).notNull(),
    bodyHtml: text("body_html"),
    bodyText: text("body_text"),
    segmentId: uuid("segment_id")
      .notNull()
      .references(() => marketingSegments.id),
    status: varchar("status", { length: 16 }).notNull().default("draft"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    connectionId: uuid("connection_id"),
    recipientCount: integer("recipient_count").notNull().default(0),
    sentCount: integer("sent_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
  },
  (t) => [
    index("campaigns_workspace_idx").on(t.workspaceId),
    index("campaigns_workspace_status_idx").on(t.workspaceId, t.status),
    index("campaigns_segment_idx").on(t.segmentId),
    check(
      "campaigns_status_check",
      sql`${t.status} IN ('draft', 'scheduled', 'sending', 'sent', 'cancelled')`,
    ),
  ],
)

export type MarketingCampaign = typeof campaigns.$inferSelect
export type NewMarketingCampaign = typeof campaigns.$inferInsert

export const campaignRecipients = pgTable(
  "campaign_recipients",
  {
    ...baseColumns,
    ...workspaceColumn,
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    personId: uuid("person_id").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    emailMessageId: uuid("email_message_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    failedReason: text("failed_reason"),
  },
  (t) => [
    uniqueIndex("campaign_recipients_campaign_person_uidx").on(t.campaignId, t.personId),
    index("campaign_recipients_campaign_status_idx").on(t.campaignId, t.status),
    index("campaign_recipients_workspace_idx").on(t.workspaceId),
    check(
      "campaign_recipients_status_check",
      sql`${t.status} IN ('pending', 'sending', 'sent', 'failed')`,
    ),
  ],
)

export type MarketingCampaignRecipient = typeof campaignRecipients.$inferSelect
export type NewMarketingCampaignRecipient = typeof campaignRecipients.$inferInsert
