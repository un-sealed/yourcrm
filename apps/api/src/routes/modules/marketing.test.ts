import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import {
  createMarketingCampaignsService,
  createMarketingConsentService,
  createMarketingSegmentsService,
  type MarketingCampaignRecord,
  type MarketingCampaignsService,
  type MarketingCampaignsStore,
  type MarketingConsentRecord,
  type MarketingConsentService,
  type MarketingConsentStore,
  type MarketingFilterTree,
  type MarketingQueuePort,
  type MarketingRecipientsStore,
  type MarketingSegmentRecord,
  type MarketingSegmentsService,
  type MarketingSegmentsStore,
} from "@yourcrm/crm/src/marketing"
import {
  createApiClient,
  createStore,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes } from "./marketing"

type StoredSegment = BaseRecord & {
  name: string
  description: string | null
  ownerId: string | null
  filter: MarketingFilterTree
  memberCount: number | null
  lastEvaluatedAt: string | null
}

type StoredCampaign = BaseRecord & {
  name: string
  subject: string
  bodyHtml: string | null
  bodyText: string | null
  segmentId: string
  status: string
  scheduledAt: string | null
  sentAt: string | null
  connectionId: string | null
  recipientCount: number
  sentCount: number
  failedCount: number
}

type StoredConsent = BaseRecord & {
  personId: string
  marketingConsent: boolean
  unsubscribedAt: string | null
  unsubscribeToken: string
  consentSource: string
}

function asSegment(row: StoredSegment): MarketingSegmentRecord {
  return row as unknown as MarketingSegmentRecord
}

function asCampaign(row: StoredCampaign): MarketingCampaignRecord {
  return row as unknown as MarketingCampaignRecord
}

function asConsent(row: StoredConsent): MarketingConsentRecord {
  return row as unknown as MarketingConsentRecord
}

const FIXED_WORKSPACE = "ws_fixed"

/** Real domain services over hermetic in-memory stores — no live Postgres/Redis. */
function makeServices() {
  const segments = createStore<StoredSegment>()
  const campaigns = createStore<StoredCampaign>()
  const consents = createStore<StoredConsent>()
  const enqueued: unknown[] = []

  const segmentsStore: MarketingSegmentsStore = {
    list: async (workspaceId) => ({
      data: segments.list(workspaceId).map(asSegment),
      pagination: { nextCursor: null, limit: 25 },
    }),
    findById: async (workspaceId, id) => {
      const row = segments.get(id, workspaceId)
      return row ? asSegment(row) : null
    },
    create: async (workspaceId, input, actorId) =>
      asSegment(
        segments.insert({
          ...makeBaseRecord({ workspaceId }),
          name: input.name as string,
          description: (input.description as string | null) ?? null,
          ownerId: (input.ownerId as string | null) ?? null,
          filter: input.filter as MarketingFilterTree,
          memberCount: null,
          lastEvaluatedAt: null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      ),
    update: async (workspaceId, id, input) => {
      const row = segments.update(id, workspaceId, input as Partial<StoredSegment>)
      return row ? asSegment(row) : null
    },
    softDelete: async (workspaceId, id) => {
      segments.remove(id, workspaceId)
    },
    restore: async (workspaceId, id) => {
      segments.restore(id, workspaceId)
    },
    evaluate: async () => ({ count: 0 }),
    recordEvaluation: async () => undefined,
  }

  const campaignsStore: MarketingCampaignsStore = {
    list: async (workspaceId, query) => {
      let rows = campaigns.list(workspaceId)
      if (query.status) rows = rows.filter((r) => r.status === query.status)
      return { data: rows.map(asCampaign), pagination: { nextCursor: null, limit: 25 } }
    },
    findById: async (workspaceId, id) => {
      const row = campaigns.get(id, workspaceId)
      return row ? asCampaign(row) : null
    },
    create: async (workspaceId, input, actorId) =>
      asCampaign(
        campaigns.insert({
          ...makeBaseRecord({ workspaceId }),
          name: input.name as string,
          subject: input.subject as string,
          bodyHtml: (input.bodyHtml as string | null) ?? null,
          bodyText: (input.bodyText as string | null) ?? null,
          segmentId: input.segmentId as string,
          status: "draft",
          scheduledAt: null,
          sentAt: null,
          connectionId: (input.connectionId as string | null) ?? null,
          recipientCount: 0,
          sentCount: 0,
          failedCount: 0,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      ),
    update: async (workspaceId, id, input) => {
      const row = campaigns.update(id, workspaceId, input as Partial<StoredCampaign>)
      return row ? asCampaign(row) : null
    },
    softDelete: async (workspaceId, id) => {
      campaigns.remove(id, workspaceId)
    },
    setStatus: async (workspaceId, id, status, extra = {}) => {
      const patch: Partial<StoredCampaign> = { status }
      if (extra.scheduledAt !== undefined) {
        patch.scheduledAt = extra.scheduledAt ? extra.scheduledAt.toISOString() : null
      }
      if (extra.sentAt !== undefined)
        patch.sentAt = extra.sentAt ? extra.sentAt.toISOString() : null
      const row = campaigns.update(id, workspaceId, patch)
      return row ? asCampaign(row) : null
    },
    setCounters: async (workspaceId, id, counters) => {
      campaigns.update(id, workspaceId, counters as Partial<StoredCampaign>)
    },
    incrementCounters: async () => undefined,
  }

  const recipientsStore: MarketingRecipientsStore = {
    prepareRecipients: async () => ({ inserted: 0 }),
    claimBatch: async () => [],
    markSent: async () => null,
    markFailed: async () => null,
    countsByStatus: async () => ({}),
  }

  const consentStore: MarketingConsentStore = {
    findByPersonId: async (workspaceId, personId) => {
      const row = consents.list(workspaceId).find((c) => c.personId === personId)
      return row ? asConsent(row) : null
    },
    findByToken: async (token) => {
      // Single-workspace fixture: scan every row this test created.
      for (const row of consents.list(FIXED_WORKSPACE)) {
        if (row.unsubscribeToken === token) return asConsent(row)
      }
      return null
    },
    upsert: async (workspaceId, input, actorId) =>
      asConsent(
        consents.insert({
          ...makeBaseRecord({ workspaceId }),
          personId: input.personId,
          marketingConsent: input.marketingConsent,
          unsubscribedAt: input.marketingConsent ? null : new Date().toISOString(),
          unsubscribeToken: `token-${input.personId}`,
          consentSource: input.source ?? "manual",
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      ),
    unsubscribeByToken: async (token) => {
      for (const row of consents.list(FIXED_WORKSPACE)) {
        if (row.unsubscribeToken === token) {
          const updated = consents.update(row.id, FIXED_WORKSPACE, {
            marketingConsent: false,
            unsubscribedAt: new Date().toISOString(),
          })
          return updated ? asConsent(updated) : null
        }
      }
      return null
    },
  }

  const queue: MarketingQueuePort = {
    enqueueCampaignBatch: async (request) => {
      enqueued.push(request)
    },
  }

  const segmentsService = createMarketingSegmentsService({
    store: segmentsStore,
    audit: async () => undefined,
  })
  const campaignsService = createMarketingCampaignsService({
    campaigns: campaignsStore,
    segments: segmentsStore,
    recipients: recipientsStore,
    queue,
    audit: async () => undefined,
  })
  const consentService = createMarketingConsentService({
    store: consentStore,
    audit: async () => undefined,
  })

  return { segmentsService, campaignsService, consentService, enqueued }
}

function makeTestApp(
  session: { current: Session | null },
  services: {
    segmentsService: MarketingSegmentsService
    campaignsService: MarketingCampaignsService
    consentService: MarketingConsentService
  },
) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/marketing", createRoutes(services))
  return app
}

describe("api/marketing", () => {
  let session: { current: Session | null }
  let services: ReturnType<typeof makeServices>
  let ctx: ReturnType<typeof makeServiceContext>

  beforeEach(() => {
    const owner = makeSession({ role: "owner", workspaceId: FIXED_WORKSPACE })
    ctx = makeServiceContext({ session: owner })
    session = { current: owner }
    services = makeServices()
  })

  test("unauthenticated requests get UNAUTHORIZED", async () => {
    session.current = null
    const api = createApiClient({ app: makeTestApp(session, services) })
    const res = await api.get("/api/v1/marketing/segments")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("segment CRUD round-trips through the envelope", async () => {
    const api = createApiClient({ app: makeTestApp(session, services) })
    const created = await api.post("/api/v1/marketing/segments", {
      name: "Active people",
      filter: {
        type: "group",
        id: "root",
        combinator: "and",
        children: [
          { type: "condition", id: "c1", field: "status", operator: "eq", value: "active" },
        ],
      },
    })
    expect(created.status).toBe(201)
    const segmentId = (created.expectSuccess().data as { id: string }).id

    const list = await api.get("/api/v1/marketing/segments")
    expect(list.status).toBe(200)
    expect(list.expectSuccess().data).toHaveLength(1)

    const patched = await api.patch(`/api/v1/marketing/segments/${segmentId}`, {
      description: "updated",
    })
    expect(patched.status).toBe(200)

    const deleted = await api.delete(`/api/v1/marketing/segments/${segmentId}`)
    expect(deleted.status).toBe(200)
    const missing = await api.get(`/api/v1/marketing/segments/${segmentId}`)
    expect(missing.status).toBe(404)
  })

  test("campaign create validates the segment exists", async () => {
    const api = createApiClient({ app: makeTestApp(session, services) })
    const res = await api.post("/api/v1/marketing/campaigns", {
      name: "A",
      subject: "S",
      segmentId: "does-not-exist",
    })
    expect(res.status).toBe(404)
    res.expectError("NOT_FOUND")
  })

  test("send requires send_external — a viewer gets 403, a member gets 200", async () => {
    const api = createApiClient({ app: makeTestApp(session, services) })
    const segmentRes = await api.post("/api/v1/marketing/segments", {
      name: "Everyone",
      filter: { type: "group", id: "root", combinator: "and", children: [] },
    })
    const segmentId = (segmentRes.expectSuccess().data as { id: string }).id
    const campaignRes = await api.post("/api/v1/marketing/campaigns", {
      name: "A",
      subject: "S",
      segmentId,
    })
    const campaignId = (campaignRes.expectSuccess().data as { id: string }).id

    session.current = makeSession({ role: "viewer", workspaceId: ctx.workspaceId })
    const viewerApi = createApiClient({ app: makeTestApp(session, services) })
    const denied = await viewerApi.post(`/api/v1/marketing/campaigns/${campaignId}/send`)
    expect(denied.status).toBe(403)
    denied.expectError("FORBIDDEN")
    expect(services.enqueued).toHaveLength(0)

    session.current = makeSession({ role: "member", workspaceId: ctx.workspaceId })
    const memberApi = createApiClient({ app: makeTestApp(session, services) })
    const allowed = await memberApi.post(`/api/v1/marketing/campaigns/${campaignId}/send`)
    expect(allowed.status).toBe(200)
    expect(services.enqueued).toHaveLength(1)
  })

  test("cancel moves a draft campaign to cancelled", async () => {
    const api = createApiClient({ app: makeTestApp(session, services) })
    const segmentRes = await api.post("/api/v1/marketing/segments", {
      name: "Everyone",
      filter: { type: "group", id: "root", combinator: "and", children: [] },
    })
    const segmentId = (segmentRes.expectSuccess().data as { id: string }).id
    const campaignRes = await api.post("/api/v1/marketing/campaigns", {
      name: "A",
      subject: "S",
      segmentId,
    })
    const campaignId = (campaignRes.expectSuccess().data as { id: string }).id
    const cancelled = await api.post(`/api/v1/marketing/campaigns/${campaignId}/cancel`)
    expect(cancelled.status).toBe(200)
    expect((cancelled.expectSuccess().data as { status: string }).status).toBe("cancelled")
  })

  test("unsubscribe needs no session and rejects an unknown token", async () => {
    const api = createApiClient({ app: makeTestApp(session, services) })
    const granted = await api.post("/api/v1/marketing/consents", {
      personId: "person-1",
      marketingConsent: true,
    })
    expect(granted.status).toBe(200)
    const token = (granted.expectSuccess().data as { unsubscribeToken: string }).unsubscribeToken

    session.current = null // no session at all
    const publicApi = createApiClient({ app: makeTestApp(session, services) })
    const ok = await publicApi.post("/api/v1/marketing/unsubscribe", { token })
    expect(ok.status).toBe(200)
    expect((ok.expectSuccess().data as { unsubscribed: boolean }).unsubscribed).toBe(true)

    const bad = await publicApi.post("/api/v1/marketing/unsubscribe", { token: "no-such-token" })
    expect(bad.status).toBe(404)
    bad.expectError("NOT_FOUND")
  })
})
