import { and, eq, ilike, isNull, sql, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import { people } from "../schema/people"
import {
  campaignRecipients,
  campaigns,
  isMarketingCampaignStatus,
  marketingConsents,
  marketingSegments,
  type MarketingCampaign,
  type MarketingCampaignRecipient,
  type MarketingConsent,
  type MarketingFilterTree,
  type MarketingSegment,
  type NewMarketingCampaign,
  type NewMarketingSegment,
} from "../schema/marketing"
import { compileReportFilter, resolveReportObject } from "./reports-repository"
import type { ReportFilterTree } from "../schema/reports"
import { createBaseRepository } from "./base-repository"

/**
 * Marketing / Campaigns repository (spec 24-marketing, P0). Migration
 * `0290_marketing.sql`.
 *
 * SEGMENT EVALUATION reuses the reports engine's allowlisted `person`
 * object (`REPORT_OBJECTS.person` in `reports-repository.ts`) instead of
 * inventing a second compiler: `resolveReportObject("person")` +
 * `compileReportFilter()` turn a stored `MarketingFilterTree` — the exact
 * `@yourcrm/ui` FilterBuilder encoding, restated in `schema/marketing.ts`
 * like `schema/reports.ts` restates it — into a parameterised drizzle
 * predicate. No user string ever reaches SQL text (same allowlist gate as
 * reports); only bound values do.
 *
 * CONSENT / UNSUBSCRIBE (the point of this module — see `prepareRecipients`
 * below): a `campaign_recipients` row is created ONLY when the person both
 * matches the segment filter AND has a `marketing_consents` row with
 * `marketing_consent = true AND unsubscribed_at IS NULL`. That predicate is
 * part of the same INSERT ... SELECT statement — there is no separate
 * "send, then drop the unsubscribed ones" step to forget. A person with no
 * consent row, `marketing_consent = false`, or a non-null
 * `unsubscribed_at` simply never appears in the SELECT, so no row, no
 * claim, no email — enforced by an inner join, not application code.
 *
 * IDEMPOTENCY: `campaign_recipients` has a UNIQUE (campaign_id, person_id)
 * index (0290_marketing.sql), so `prepareRecipients` is safe to call twice
 * (`ON CONFLICT DO NOTHING`). Sending claims a batch with
 * `UPDATE ... WHERE status = 'pending' ... FOR UPDATE SKIP LOCKED`
 * (`claimBatch`): a retried/duplicated job finds nothing left in `pending`
 * for rows already claimed or sent, so it sends zero mail instead of a
 * second copy.
 */

export class MarketingSegmentFilterError extends Error {
  readonly code = "INVALID_SEGMENT_FILTER"
  constructor(message: string) {
    super(message)
    this.name = "MarketingSegmentFilterError"
  }
}

/** Allowlisted compile of a segment's filter tree against the `person` object. */
export function compileMarketingSegmentFilter(
  filter: MarketingFilterTree | null | undefined,
): SQL | undefined {
  const object = resolveReportObject("person")
  try {
    return compileReportFilter(object, filter as unknown as ReportFilterTree | null | undefined)
  } catch (err) {
    throw new MarketingSegmentFilterError(err instanceof Error ? err.message : String(err))
  }
}

/* ------------------------------- segments ------------------------------ */

export type CreateMarketingSegmentInput = {
  name: string
  description?: string | null
  ownerId?: string | null
  filter: MarketingFilterTree
}

export type UpdateMarketingSegmentInput = Partial<CreateMarketingSegmentInput>

function toSegmentValues(
  input: CreateMarketingSegmentInput | UpdateMarketingSegmentInput,
  actorId?: string,
): Partial<NewMarketingSegment> {
  const values: Partial<NewMarketingSegment> = {}
  if (input.name !== undefined) {
    const trimmed = input.name.trim()
    if (trimmed.length === 0) throw new Error("marketing_segments: name must not be empty")
    values.name = trimmed
  }
  if (input.description !== undefined) values.description = input.description
  if (input.ownerId !== undefined) values.ownerId = input.ownerId
  if (input.filter !== undefined) values.filter = input.filter
  if (actorId !== undefined) values.updatedBy = actorId
  return values
}

export function createMarketingSegmentsRepository() {
  const base = createBaseRepository(marketingSegments)

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateMarketingSegmentInput,
      actorId?: string,
    ): Promise<MarketingSegment> {
      const rows = await db
        .insert(marketingSegments)
        .values({
          ...toSegmentValues(input, actorId),
          workspaceId,
          name: input.name.trim(),
          filter: input.filter,
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("marketing_segments.create: insert returned no rows")
      return row
    },

    async search(
      db: Database,
      opts: {
        workspaceId: string
        limit?: number
        cursor?: string
        order?: "asc" | "desc"
        query?: string
      },
    ) {
      const conditions: SQL[] = []
      if (opts.query) conditions.push(ilike(marketingSegments.name, `%${opts.query.trim()}%`))
      const result = await base.list(db, { ...opts, where: conditions })
      return { data: result.data as MarketingSegment[], pagination: result.pagination }
    },

    async findById(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<MarketingSegment | null> {
      const row = await base.findById(db, workspaceId, id)
      return (row as MarketingSegment | null) ?? null
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateMarketingSegmentInput,
      actorId?: string,
    ): Promise<MarketingSegment | null> {
      const rows = await db
        .update(marketingSegments)
        .set({ ...toSegmentValues(input, actorId), updatedAt: new Date() })
        .where(
          and(
            eq(marketingSegments.id, id),
            eq(marketingSegments.workspaceId, workspaceId),
            isNull(marketingSegments.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    /**
     * Preview / cache a segment's live member count. Send time re-evaluates
     * the same predicate independently (`prepareRecipients`) — this is
     * informational only, never trusted for exclusion decisions.
     */
    async evaluate(
      db: Database,
      workspaceId: string,
      filter: MarketingFilterTree,
    ): Promise<{ count: number }> {
      const predicate = compileMarketingSegmentFilter(filter)
      const conditions: SQL[] = [eq(people.workspaceId, workspaceId), isNull(people.deletedAt)]
      if (predicate) conditions.push(predicate)
      const rows = await db
        .select({ count: sql<number>`count(*)` })
        .from(people)
        .where(and(...conditions))
      return { count: Number(rows[0]?.count ?? 0) }
    },

    async recordEvaluation(
      db: Database,
      workspaceId: string,
      id: string,
      memberCount: number,
    ): Promise<void> {
      await db
        .update(marketingSegments)
        .set({ memberCount, lastEvaluatedAt: new Date() })
        .where(and(eq(marketingSegments.id, id), eq(marketingSegments.workspaceId, workspaceId)))
    },
  }
}

export type MarketingSegmentsRepository = ReturnType<typeof createMarketingSegmentsRepository>

/* ------------------------------- consent -------------------------------- */

export type UpsertMarketingConsentInput = {
  personId: string
  marketingConsent: boolean
  source?: string
}

export function createMarketingConsentRepository() {
  return {
    async findByPersonId(
      db: Database,
      workspaceId: string,
      personId: string,
    ): Promise<MarketingConsent | null> {
      const rows = await db
        .select()
        .from(marketingConsents)
        .where(
          and(
            eq(marketingConsents.workspaceId, workspaceId),
            eq(marketingConsents.personId, personId),
            isNull(marketingConsents.deletedAt),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },

    async findByToken(db: Database, token: string): Promise<MarketingConsent | null> {
      const rows = await db
        .select()
        .from(marketingConsents)
        .where(
          and(eq(marketingConsents.unsubscribeToken, token), isNull(marketingConsents.deletedAt)),
        )
        .limit(1)
      return rows[0] ?? null
    },

    /** Grant/record consent. Insert-or-update, keyed by (workspace, person). */
    async upsert(
      db: Database,
      workspaceId: string,
      input: UpsertMarketingConsentInput,
      actorId?: string,
    ): Promise<MarketingConsent> {
      const rows = await db
        .insert(marketingConsents)
        .values({
          workspaceId,
          personId: input.personId,
          marketingConsent: input.marketingConsent,
          consentSource: input.source ?? "manual",
          lastConsentEventAt: new Date(),
          unsubscribedAt: input.marketingConsent ? null : new Date(),
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .onConflictDoUpdate({
          target: [marketingConsents.workspaceId, marketingConsents.personId],
          // The unique index is partial (`WHERE deleted_at IS NULL`) — the
          // arbiter needs the same predicate or Postgres cannot pick it.
          targetWhere: isNull(marketingConsents.deletedAt),
          set: {
            marketingConsent: input.marketingConsent,
            consentSource: input.source ?? "manual",
            lastConsentEventAt: new Date(),
            unsubscribedAt: input.marketingConsent ? null : new Date(),
            updatedAt: new Date(),
            ...(actorId === undefined ? {} : { updatedBy: actorId }),
          },
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("marketing_consents.upsert: insert returned no rows")
      return row
    },

    /** Token-authenticated unsubscribe: possession of the token IS the authorization. */
    async unsubscribeByToken(db: Database, token: string): Promise<MarketingConsent | null> {
      const rows = await db
        .update(marketingConsents)
        .set({
          marketingConsent: false,
          unsubscribedAt: new Date(),
          lastConsentEventAt: new Date(),
          consentSource: "unsubscribe_link",
        })
        .where(
          and(eq(marketingConsents.unsubscribeToken, token), isNull(marketingConsents.deletedAt)),
        )
        .returning()
      return rows[0] ?? null
    },
  }
}

export type MarketingConsentRepository = ReturnType<typeof createMarketingConsentRepository>

/* ------------------------------- campaigns ------------------------------ */

export type CreateMarketingCampaignInput = {
  name: string
  subject: string
  bodyHtml?: string | null
  bodyText?: string | null
  segmentId: string
  ownerId?: string | null
  connectionId?: string | null
}

export type UpdateMarketingCampaignInput = Partial<CreateMarketingCampaignInput>

function toCampaignValues(
  input: CreateMarketingCampaignInput | UpdateMarketingCampaignInput,
  actorId?: string,
): Partial<NewMarketingCampaign> {
  const values: Partial<NewMarketingCampaign> = {}
  if (input.name !== undefined) values.name = input.name.trim()
  if (input.subject !== undefined) values.subject = input.subject.trim()
  if (input.bodyHtml !== undefined) values.bodyHtml = input.bodyHtml
  if (input.bodyText !== undefined) values.bodyText = input.bodyText
  if (input.segmentId !== undefined) values.segmentId = input.segmentId
  if (input.ownerId !== undefined) values.ownerId = input.ownerId
  if (input.connectionId !== undefined) values.connectionId = input.connectionId
  if (actorId !== undefined) values.updatedBy = actorId
  return values
}

export function createMarketingCampaignsRepository() {
  const base = createBaseRepository(campaigns)

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateMarketingCampaignInput,
      actorId?: string,
    ): Promise<MarketingCampaign> {
      const rows = await db
        .insert(campaigns)
        .values({
          ...toCampaignValues(input, actorId),
          workspaceId,
          name: input.name.trim(),
          subject: input.subject.trim(),
          segmentId: input.segmentId,
          status: "draft",
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("campaigns.create: insert returned no rows")
      return row
    },

    async search(
      db: Database,
      opts: {
        workspaceId: string
        limit?: number
        cursor?: string
        order?: "asc" | "desc"
        query?: string
        status?: string
      },
    ) {
      const conditions: SQL[] = []
      if (opts.query) conditions.push(ilike(campaigns.name, `%${opts.query.trim()}%`))
      if (opts.status) {
        if (!isMarketingCampaignStatus(opts.status)) {
          throw new Error("campaigns.search: unknown status filter")
        }
        conditions.push(eq(campaigns.status, opts.status))
      }
      const result = await base.list(db, { ...opts, where: conditions })
      return { data: result.data as MarketingCampaign[], pagination: result.pagination }
    },

    async findById(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<MarketingCampaign | null> {
      const row = await base.findById(db, workspaceId, id)
      return (row as MarketingCampaign | null) ?? null
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateMarketingCampaignInput,
      actorId?: string,
    ): Promise<MarketingCampaign | null> {
      const rows = await db
        .update(campaigns)
        .set({ ...toCampaignValues(input, actorId), updatedAt: new Date() })
        .where(
          and(
            eq(campaigns.id, id),
            eq(campaigns.workspaceId, workspaceId),
            isNull(campaigns.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    async setStatus(
      db: Database,
      workspaceId: string,
      id: string,
      status: string,
      extra: { scheduledAt?: Date | null; sentAt?: Date | null } = {},
    ): Promise<MarketingCampaign | null> {
      const rows = await db
        .update(campaigns)
        .set({ status, updatedAt: new Date(), ...extra })
        .where(and(eq(campaigns.id, id), eq(campaigns.workspaceId, workspaceId)))
        .returning()
      return rows[0] ?? null
    },

    async setCounters(
      db: Database,
      workspaceId: string,
      id: string,
      counters: Partial<Pick<MarketingCampaign, "recipientCount" | "sentCount" | "failedCount">>,
    ): Promise<void> {
      await db
        .update(campaigns)
        .set({ ...counters, updatedAt: new Date() })
        .where(and(eq(campaigns.id, id), eq(campaigns.workspaceId, workspaceId)))
    },

    async incrementCounters(
      db: Database,
      workspaceId: string,
      id: string,
      delta: { sentCount?: number; failedCount?: number },
    ): Promise<void> {
      const set: Record<string, SQL> = { updatedAt: sql`now()` }
      if (delta.sentCount) set.sentCount = sql`${campaigns.sentCount} + ${delta.sentCount}`
      if (delta.failedCount) set.failedCount = sql`${campaigns.failedCount} + ${delta.failedCount}`
      await db
        .update(campaigns)
        .set(set)
        .where(and(eq(campaigns.id, id), eq(campaigns.workspaceId, workspaceId)))
    },
  }
}

export type MarketingCampaignsRepository = ReturnType<typeof createMarketingCampaignsRepository>

/* ----------------------------- recipients -------------------------------- */

export type PrepareRecipientsResult = { inserted: number }

/**
 * Pure statement builder for `prepareRecipients` — no `Database` needed to
 * construct it, so hermetic tests can serialise it with `PgDialect` and
 * assert on the SQL text/params directly (same technique
 * `reports-repository.test.ts` uses for `planReportExecution`).
 *
 * THE SQL THAT MAKES CONSENT NOT OPTIONAL: the `INNER JOIN` onto
 * `marketing_consents` with `marketing_consent = true AND unsubscribed_at
 * IS NULL` is part of the SELECT that feeds the INSERT — a person failing
 * that join is never read, let alone inserted. `ON CONFLICT DO NOTHING` on
 * the (campaign_id, person_id) unique index makes a repeated call
 * (re-clicking "send", a retried job) additive-safe: already-inserted
 * people are simply skipped, never duplicated.
 *
 * Every identifier below is a hardcoded column/table name; every value is
 * either a bound parameter or an already-compiled, allowlisted `SQL`
 * fragment (`compileMarketingSegmentFilter`) — no user string reaches SQL
 * text, same discipline as `reports-repository.ts`.
 */
export function buildPrepareRecipientsStatement(params: {
  workspaceId: string
  campaignId: string
  segmentFilter: MarketingFilterTree
}): SQL {
  const predicate = compileMarketingSegmentFilter(params.segmentFilter)
  const conditions: SQL[] = [
    eq(people.workspaceId, params.workspaceId),
    isNull(people.deletedAt),
    eq(marketingConsents.marketingConsent, true),
    isNull(marketingConsents.unsubscribedAt),
  ]
  if (predicate) conditions.push(predicate)

  return sql`
    INSERT INTO campaign_recipients (workspace_id, campaign_id, person_id, status)
    SELECT ${params.workspaceId}::uuid, ${params.campaignId}::uuid, ${people.id}, 'pending'
    FROM ${people}
    INNER JOIN ${marketingConsents}
      ON ${marketingConsents.personId} = ${people.id}
     AND ${marketingConsents.workspaceId} = ${people.workspaceId}
    WHERE ${and(...conditions)}
    ON CONFLICT (campaign_id, person_id) DO NOTHING
    RETURNING id
  `
}

/**
 * Pure statement builder for `claimBatch` — same reasoning as
 * `buildPrepareRecipientsStatement`. `FOR UPDATE SKIP LOCKED` inside the
 * `WHERE id IN (...)` subquery means two workers (or a retry racing the
 * original attempt) never claim the same row — each claims a disjoint
 * subset, and a row already claimed (`sending`, `sent` or `failed`) is
 * invisible to the inner `status = 'pending'` predicate, so a retried
 * batch claims nothing left to claim instead of re-sending.
 */
export function buildClaimBatchStatement(params: {
  workspaceId: string
  campaignId: string
  limit: number
}): SQL {
  return sql`
    UPDATE campaign_recipients
    SET status = 'sending', claimed_at = now(), updated_at = now()
    WHERE id IN (
      SELECT id FROM campaign_recipients
      WHERE workspace_id = ${params.workspaceId}::uuid
        AND campaign_id = ${params.campaignId}::uuid
        AND status = 'pending'
      ORDER BY created_at
      LIMIT ${params.limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `
}

export function createMarketingRecipientsRepository() {
  return {
    async prepareRecipients(
      db: Database,
      params: { workspaceId: string; campaignId: string; segmentFilter: MarketingFilterTree },
    ): Promise<PrepareRecipientsResult> {
      const raw = (await db.execute(buildPrepareRecipientsStatement(params))) as unknown as Record<
        string,
        unknown
      >[]
      return { inserted: Array.isArray(raw) ? raw.length : 0 }
    },

    /** Claim-before-send: see `buildClaimBatchStatement`. */
    async claimBatch(
      db: Database,
      params: { workspaceId: string; campaignId: string; limit: number },
    ): Promise<MarketingCampaignRecipient[]> {
      const raw = (await db.execute(buildClaimBatchStatement(params))) as unknown as Record<
        string,
        unknown
      >[]
      return raw as unknown as MarketingCampaignRecipient[]
    },

    async markSent(
      db: Database,
      id: string,
      emailMessageId: string | null,
    ): Promise<MarketingCampaignRecipient | null> {
      const rows = await db
        .update(campaignRecipients)
        .set({ status: "sent", sentAt: new Date(), emailMessageId, updatedAt: new Date() })
        .where(eq(campaignRecipients.id, id))
        .returning()
      return rows[0] ?? null
    },

    async markFailed(
      db: Database,
      id: string,
      reason: string,
    ): Promise<MarketingCampaignRecipient | null> {
      const rows = await db
        .update(campaignRecipients)
        .set({ status: "failed", failedReason: reason.slice(0, 4000), updatedAt: new Date() })
        .where(eq(campaignRecipients.id, id))
        .returning()
      return rows[0] ?? null
    },

    async countsByStatus(
      db: Database,
      workspaceId: string,
      campaignId: string,
    ): Promise<Record<string, number>> {
      const rows = await db
        .select({ status: campaignRecipients.status, count: sql<number>`count(*)` })
        .from(campaignRecipients)
        .where(
          and(
            eq(campaignRecipients.workspaceId, workspaceId),
            eq(campaignRecipients.campaignId, campaignId),
          ),
        )
        .groupBy(campaignRecipients.status)
      const out: Record<string, number> = {}
      for (const row of rows) out[row.status] = Number(row.count)
      return out
    },
  }
}

export type MarketingRecipientsRepository = ReturnType<typeof createMarketingRecipientsRepository>
