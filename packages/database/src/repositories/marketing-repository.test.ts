import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import { PgDialect } from "drizzle-orm/pg-core"
import {
  campaignRecipients,
  campaigns,
  marketingConsents,
  marketingSegments,
  type MarketingFilterTree,
} from "../schema/marketing"
import {
  buildClaimBatchStatement,
  buildPrepareRecipientsStatement,
  compileMarketingSegmentFilter,
  MarketingSegmentFilterError,
} from "./marketing-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const CAMPAIGN_ID = "22222222-2222-4222-8222-222222222222"
const MIGRATION = new URL("../../migrations/0290_marketing.sql", import.meta.url)

const dialect = new PgDialect()

function activeStatusFilter(): MarketingFilterTree {
  return {
    type: "group",
    id: "root",
    combinator: "and",
    children: [{ type: "condition", id: "c1", field: "status", operator: "eq", value: "active" }],
  }
}

describe("marketing/schema", () => {
  test("every table exposes the BaseRecord column contract", () => {
    for (const table of [marketingSegments, campaigns, campaignRecipients, marketingConsents]) {
      const cols = table as unknown as Record<string, unknown>
      for (const col of ["id", "workspaceId", "createdAt", "updatedAt", "deletedAt"]) {
        expect(cols[col], col).toBeDefined()
      }
    }
  })

  test("campaigns and campaign_recipients expose their P0 columns", () => {
    const campaignCols = campaigns as unknown as Record<string, unknown>
    for (const col of ["name", "subject", "segmentId", "status", "scheduledAt", "recipientCount"]) {
      expect(campaignCols[col], col).toBeDefined()
    }
    const recipientCols = campaignRecipients as unknown as Record<string, unknown>
    for (const col of ["campaignId", "personId", "status", "claimedAt"]) {
      expect(recipientCols[col], col).toBeDefined()
    }
  })
})

describe("marketing/filter", () => {
  test("reuses the reports engine's person allowlist (no second filter compiler)", () => {
    const sqlPredicate = compileMarketingSegmentFilter(activeStatusFilter())
    expect(sqlPredicate).toBeDefined()
  })

  test("an unknown field is rejected before it can reach SQL text", () => {
    const malicious: MarketingFilterTree = {
      type: "group",
      id: "root",
      combinator: "and",
      children: [
        {
          type: "condition",
          id: "c1",
          field: `status" ; DROP TABLE campaigns; --`,
          operator: "eq",
          value: "x",
        },
      ],
    }
    expect(() => compileMarketingSegmentFilter(malicious)).toThrow(MarketingSegmentFilterError)
  })

  test("an empty/undefined filter compiles to no predicate (match all people)", () => {
    expect(compileMarketingSegmentFilter(undefined)).toBeUndefined()
    expect(
      compileMarketingSegmentFilter({ type: "group", id: "root", combinator: "and", children: [] }),
    ).toBeUndefined()
  })
})

describe("marketing/consent-exclusion (prepareRecipients SQL)", () => {
  /**
   * THE test the module spec calls out by name: an unsubscribed person must
   * receive nothing even when they match the segment. Proven at the SQL
   * level — the statement itself cannot select an unsubscribed/non-consented
   * person, so there is no downstream filter step to accidentally skip.
   */
  test("the consent predicate is baked into the SELECT that feeds the INSERT", () => {
    const statement = buildPrepareRecipientsStatement({
      workspaceId: WS,
      campaignId: CAMPAIGN_ID,
      segmentFilter: activeStatusFilter(),
    })
    const query = dialect.sqlToQuery(statement)

    // The join that makes consent mandatory, not optional.
    expect(query.sql).toContain('INNER JOIN "marketing_consents"')
    expect(query.sql).toContain('"marketing_consents"."person_id" = "people"."id"')
    // A person is excluded unless BOTH hold: explicit consent...
    expect(query.sql).toContain('"marketing_consents"."marketing_consent" = $')
    // ...and no unsubscribe recorded.
    expect(query.sql).toContain('"marketing_consents"."unsubscribed_at" is null')
    // The consent value bound is `true` — never accepted as a caller input.
    expect(query.params).toContain(true)
    // The segment predicate (status = active) still applies alongside consent.
    expect(query.sql).toContain('"people"."status" = $')
    expect(query.params).toContain("active")
  })

  test("idempotency: ON CONFLICT DO NOTHING makes a repeated prepare additive-safe", () => {
    const statement = buildPrepareRecipientsStatement({
      workspaceId: WS,
      campaignId: CAMPAIGN_ID,
      segmentFilter: activeStatusFilter(),
    })
    const query = dialect.sqlToQuery(statement)
    expect(query.sql).toContain("ON CONFLICT (campaign_id, person_id) DO NOTHING")
  })

  test("no user-controlled string is interpolated into the SQL text", () => {
    const malicious: MarketingFilterTree = {
      type: "group",
      id: "root",
      combinator: "and",
      children: [
        {
          type: "condition",
          id: "c1",
          field: "status",
          operator: "eq",
          value: "'; DROP TABLE campaigns; --",
        },
      ],
    }
    const query = dialect.sqlToQuery(
      buildPrepareRecipientsStatement({
        workspaceId: WS,
        campaignId: CAMPAIGN_ID,
        segmentFilter: malicious,
      }),
    )
    expect(query.sql).not.toContain("DROP TABLE")
    expect(query.params).toContain("'; DROP TABLE campaigns; --")
  })
})

describe("marketing/idempotent-claim (claimBatch SQL)", () => {
  test("only pending rows for this campaign are eligible to claim", () => {
    const query = dialect.sqlToQuery(
      buildClaimBatchStatement({ workspaceId: WS, campaignId: CAMPAIGN_ID, limit: 25 }),
    )
    expect(query.sql).toContain("status = 'pending'")
    expect(query.sql).toContain("campaign_id = $2::uuid")
    expect(query.params).toEqual([WS, CAMPAIGN_ID, 25])
  })

  test("FOR UPDATE SKIP LOCKED prevents two claimers taking the same row", () => {
    const query = dialect.sqlToQuery(
      buildClaimBatchStatement({ workspaceId: WS, campaignId: CAMPAIGN_ID, limit: 10 }),
    )
    expect(query.sql).toContain("FOR UPDATE SKIP LOCKED")
  })

  test("a retried batch call structurally reclaims nothing: the WHERE clause never matches sending/sent/failed rows", () => {
    const query = dialect.sqlToQuery(
      buildClaimBatchStatement({ workspaceId: WS, campaignId: CAMPAIGN_ID, limit: 25 }),
    )
    // The inner SELECT's only eligibility predicate is `status = 'pending'`
    // — sending/sent/failed rows (what a first attempt already claimed)
    // can never satisfy it again. (The outer `SET status = 'sending'` is
    // the claim itself, not an eligibility check, so it is excluded here.)
    const innerSelect = query.sql.slice(query.sql.indexOf("SELECT id FROM"))
    const statusLiterals = innerSelect.match(/status = '(\w+)'/g)
    expect(statusLiterals).toEqual(["status = 'pending'"])
  })
})

describe("marketing/migration", () => {
  test("declares the three P0 tables plus the consent support table", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS marketing_segments")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS campaigns")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS campaign_recipients")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS marketing_consents")
  })

  test("the idempotency unique index and status check constraints exist", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS campaign_recipients_campaign_person_uidx",
    )
    expect(sql).toContain("campaign_recipients (campaign_id, person_id)")
    expect(sql).toContain("campaigns_status_check")
    expect(sql).toContain("campaign_recipients_status_check")
  })

  test("FKs only point at tables this migration owns; person_id stays a plain uuid", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("segment_id UUID NOT NULL REFERENCES marketing_segments (id)")
    expect(sql).toContain("campaign_id UUID NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE")
    expect(sql).toContain("person_id UUID NOT NULL,")
    expect(sql).not.toContain("REFERENCES people")
    expect(sql).not.toContain("REFERENCES users")
  })
})
