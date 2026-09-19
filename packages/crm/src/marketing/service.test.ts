import { describe, expect, test } from "bun:test"
import {
  createStore,
  expectAllowed,
  expectDenied,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { createMarketingBatchService } from "./batch-service"
import { createMarketingCampaignsService, MarketingCampaignStateError } from "./campaigns-service"
import { createMarketingConsentService, MarketingConsentNotFoundError } from "./consent-service"
import { createMarketingSegmentsService } from "./segments-service"
import type {
  MarketingCampaignRecipientRecord,
  MarketingCampaignRecord,
  MarketingCampaignSenderPort,
  MarketingCampaignsStore,
  MarketingConsentRecord,
  MarketingConsentStore,
  MarketingFilterTree,
  MarketingQueuePort,
  MarketingRecipientsStore,
  MarketingSegmentRecord,
  MarketingSegmentsStore,
} from "./types"

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

type StoredRecipient = BaseRecord & {
  campaignId: string
  personId: string
  status: string
  emailMessageId: string | null
  failedReason: string | null
}

type PersonRow = { id: string; workspaceId: string; status: "active" | "archived" }

function asSegment(row: StoredSegment): MarketingSegmentRecord {
  return row as unknown as MarketingSegmentRecord
}

function asCampaign(row: StoredCampaign): MarketingCampaignRecord {
  return row as unknown as MarketingCampaignRecord
}

function asConsent(row: StoredConsent): MarketingConsentRecord {
  return row as unknown as MarketingConsentRecord
}

function asRecipient(row: StoredRecipient): MarketingCampaignRecipientRecord {
  return row as unknown as MarketingCampaignRecipientRecord
}

/** Only what the tests need: a single `status` eq condition, like the fixtures below use. */
function personMatches(person: PersonRow, filter: MarketingFilterTree): boolean {
  if (filter.children.length === 0) return true
  return filter.children.every((node) => {
    if (node.type !== "condition") return true
    if (node.field === "status" && node.operator === "eq") return person.status === node.value
    return true
  })
}

/**
 * Hermetic fixture standing in for `marketing-repository.ts`. `prepareRecipients`
 * faithfully replicates the two guarantees proven at the SQL level in
 * `marketing-repository.test.ts`: consent exclusion (inner-join semantics)
 * and idempotency (unique-index-shaped de-dupe) — so THIS test proves the
 * service layer does not undermine either guarantee on the way to the store.
 */
function makeWorld() {
  const segments = createStore<StoredSegment>()
  const campaigns = createStore<StoredCampaign>()
  const consents = createStore<StoredConsent>()
  const recipients = createStore<StoredRecipient>()
  const people: PersonRow[] = []
  const enqueued: { workspaceId: string; campaignId: string; batchSize: number }[] = []
  const sent: { personId: string; campaignId: string }[] = []
  // `InMemoryStore` is workspace-scoped per call and has no "all rows"
  // accessor; these fixtures track every workspace id they have ever seen
  // so token/id lookups (which arrive with no workspace hint, exactly like
  // the real unsubscribe link) can still find the row.
  const knownWorkspaceIds = new Set<string>()

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
    evaluate: async (workspaceId, filter) => ({
      count: people.filter((p) => p.workspaceId === workspaceId && personMatches(p, filter)).length,
    }),
    recordEvaluation: async (workspaceId, id, memberCount) => {
      segments.update(id, workspaceId, { memberCount } as Partial<StoredSegment>)
    },
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
    incrementCounters: async (workspaceId, id, delta) => {
      const row = campaigns.get(id, workspaceId)
      if (!row) return
      campaigns.update(id, workspaceId, {
        sentCount: row.sentCount + (delta.sentCount ?? 0),
        failedCount: row.failedCount + (delta.failedCount ?? 0),
      } as Partial<StoredCampaign>)
    },
  }

  const consentStore: MarketingConsentStore = {
    findByPersonId: async (workspaceId, personId) => {
      const row = consents.list(workspaceId).find((c) => c.personId === personId)
      return row ? asConsent(row) : null
    },
    findByToken: async (token) => {
      for (const workspaceId of knownWorkspaceIds) {
        const row = consents.list(workspaceId).find((c) => c.unsubscribeToken === token)
        if (row) return asConsent(row)
      }
      return null
    },
    upsert: async (workspaceId, input, actorId) => {
      knownWorkspaceIds.add(workspaceId)
      const existing = consents.list(workspaceId).find((c) => c.personId === input.personId)
      if (existing) {
        const row = consents.update(existing.id, workspaceId, {
          marketingConsent: input.marketingConsent,
          consentSource: input.source ?? "manual",
          unsubscribedAt: input.marketingConsent ? null : new Date().toISOString(),
        })
        return asConsent(row as StoredConsent)
      }
      return asConsent(
        consents.insert({
          ...makeBaseRecord({ workspaceId }),
          personId: input.personId,
          marketingConsent: input.marketingConsent,
          unsubscribedAt: input.marketingConsent ? null : new Date().toISOString(),
          unsubscribeToken: `token-${input.personId}`,
          consentSource: input.source ?? "manual",
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      )
    },
    unsubscribeByToken: async (token) => {
      for (const workspaceId of knownWorkspaceIds) {
        const row = consents.list(workspaceId).find((c) => c.unsubscribeToken === token)
        if (row) {
          const updated = consents.update(row.id, workspaceId, {
            marketingConsent: false,
            unsubscribedAt: new Date().toISOString(),
            consentSource: "unsubscribe_link",
          })
          return updated ? asConsent(updated) : null
        }
      }
      return null
    },
  }

  const recipientsStore: MarketingRecipientsStore = {
    prepareRecipients: async ({ workspaceId, campaignId, segmentFilter }) => {
      knownWorkspaceIds.add(workspaceId)
      const matches = people.filter(
        (p) => p.workspaceId === workspaceId && personMatches(p, segmentFilter),
      )
      let inserted = 0
      for (const person of matches) {
        const consent = consents.list(workspaceId).find((c) => c.personId === person.id)
        // THE consent gate, replicated from the repository's INNER JOIN:
        // no row, no consent, or unsubscribed => never inserted.
        if (!consent || !consent.marketingConsent || consent.unsubscribedAt) continue
        const already = recipients
          .list(workspaceId)
          .find((r) => r.campaignId === campaignId && r.personId === person.id)
        if (already) continue // unique-index-shaped de-dupe: idempotent prepare
        recipients.insert({
          ...makeBaseRecord({ workspaceId }),
          campaignId,
          personId: person.id,
          status: "pending",
          emailMessageId: null,
          failedReason: null,
        })
        inserted += 1
      }
      return { inserted }
    },
    claimBatch: async ({ workspaceId, campaignId, limit }) => {
      const pending = recipients
        .list(workspaceId)
        .filter((r) => r.campaignId === campaignId && r.status === "pending")
        .slice(0, limit)
      const claimed: StoredRecipient[] = []
      for (const row of pending) {
        const updated = recipients.update(row.id, workspaceId, { status: "sending" })
        if (updated) claimed.push(updated)
      }
      return claimed.map(asRecipient)
    },
    markSent: async (id, emailMessageId) => {
      for (const workspaceId of knownWorkspaceIds) {
        const row = recipients.get(id, workspaceId)
        if (row) {
          const updated = recipients.update(id, workspaceId, { status: "sent", emailMessageId })
          return updated ? asRecipient(updated) : null
        }
      }
      return null
    },
    markFailed: async (id, reason) => {
      for (const workspaceId of knownWorkspaceIds) {
        const row = recipients.get(id, workspaceId)
        if (row) {
          const updated = recipients.update(id, workspaceId, {
            status: "failed",
            failedReason: reason,
          })
          return updated ? asRecipient(updated) : null
        }
      }
      return null
    },
    countsByStatus: async (workspaceId, campaignId) => {
      const rows = recipients.list(workspaceId).filter((r) => r.campaignId === campaignId)
      const out: Record<string, number> = {}
      for (const row of rows) out[row.status] = (out[row.status] ?? 0) + 1
      return out
    },
  }

  const queue: MarketingQueuePort = {
    enqueueCampaignBatch: async (request) => {
      enqueued.push(request)
    },
  }

  const sender: MarketingCampaignSenderPort = {
    send: async (input) => {
      sent.push({ personId: input.personId, campaignId: input.campaignId })
      return { outcome: "sent", emailMessageId: `msg-${input.personId}` }
    },
  }

  return {
    people,
    consents,
    recipients,
    enqueued,
    sent,
    segmentsStore,
    campaignsStore,
    consentStore,
    recipientsStore,
    queue,
    sender,
  }
}

describe("marketing/segments", () => {
  test("viewer read is allowed, create is denied", async () => {
    const world = makeWorld()
    const service = createMarketingSegmentsService({
      store: world.segmentsStore,
      audit: async () => undefined,
    })
    const owner = makeServiceContext({ session: makeSession({ role: "owner" }) })
    const viewer = makeServiceContext({
      session: makeSession({ role: "viewer", workspaceId: owner.workspaceId }),
    })
    await expectAllowed(() => service.list(viewer, {}))
    await expectDenied(() =>
      service.create(viewer, {
        name: "VIPs",
        filter: { type: "group", id: "root", combinator: "and", children: [] },
      }),
    )
    const created = await expectAllowed(() =>
      service.create(owner, {
        name: "Active people",
        filter: {
          type: "group",
          id: "root",
          combinator: "and",
          children: [
            { type: "condition", id: "c1", field: "status", operator: "eq", value: "active" },
          ],
        },
      }),
    )
    expect(created.name).toBe("Active people")
  })

  test("preview evaluates the live filter and caches the count", async () => {
    const world = makeWorld()
    const ctx = makeServiceContext({ session: makeSession({ role: "owner" }) })
    world.people.push(
      { id: "p1", workspaceId: ctx.workspaceId, status: "active" },
      { id: "p2", workspaceId: ctx.workspaceId, status: "archived" },
    )
    const service = createMarketingSegmentsService({
      store: world.segmentsStore,
      audit: async () => undefined,
    })
    const segment = await service.create(ctx, {
      name: "Active",
      filter: {
        type: "group",
        id: "root",
        combinator: "and",
        children: [
          { type: "condition", id: "c1", field: "status", operator: "eq", value: "active" },
        ],
      },
    })
    const result = await service.preview(ctx, segment.id)
    expect(result.count).toBe(1)
  })
})

describe("marketing/campaigns + consent: unsubscribe/consent exclusion at the service boundary", () => {
  test("a person who unsubscribed receives nothing even though they match the segment", async () => {
    const world = makeWorld()
    const owner = makeServiceContext({ session: makeSession({ role: "owner" }) })
    world.people.push(
      { id: "consented", workspaceId: owner.workspaceId, status: "active" },
      { id: "unsubscribed", workspaceId: owner.workspaceId, status: "active" },
    )
    const consentService = createMarketingConsentService({
      store: world.consentStore,
      audit: async () => undefined,
    })
    await consentService.grant(owner, { personId: "consented", marketingConsent: true })
    await consentService.grant(owner, { personId: "unsubscribed", marketingConsent: true })
    // The person opts back OUT — matches the segment filter identically to "consented".
    await consentService.grant(owner, { personId: "unsubscribed", marketingConsent: false })

    const segmentsService = createMarketingSegmentsService({
      store: world.segmentsStore,
      audit: async () => undefined,
    })
    const segment = await segmentsService.create(owner, {
      name: "Everyone active",
      filter: {
        type: "group",
        id: "root",
        combinator: "and",
        children: [
          { type: "condition", id: "c1", field: "status", operator: "eq", value: "active" },
        ],
      },
    })
    // Both people match the segment filter (sanity check).
    expect((await segmentsService.preview(owner, segment.id)).count).toBe(2)

    const campaignsService = createMarketingCampaignsService({
      campaigns: world.campaignsStore,
      segments: world.segmentsStore,
      recipients: world.recipientsStore,
      queue: world.queue,
      audit: async () => undefined,
    })
    const campaign = await campaignsService.create(owner, {
      name: "Announce",
      subject: "Hello",
      segmentId: segment.id,
    })
    await campaignsService.send(owner, campaign.id)

    const recipientRows = world.recipients
      .list(owner.workspaceId)
      .filter((r) => r.campaignId === campaign.id)
    expect(recipientRows.map((r) => r.personId).sort()).toEqual(["consented"])
    expect(recipientRows.some((r) => r.personId === "unsubscribed")).toBe(false)

    // Sending the batches later must not reach the unsubscribed person either.
    const batchService = createMarketingBatchService({
      campaigns: world.campaignsStore,
      recipients: world.recipientsStore,
      sender: world.sender,
      audit: async () => undefined,
    })
    await batchService.sendBatch(owner.workspaceId, campaign.id, 50)
    expect(world.sent.map((s) => s.personId)).toEqual(["consented"])
  })

  test("a person with no consent record at all is excluded (opt-in, not opt-out)", async () => {
    const world = makeWorld()
    const owner = makeServiceContext({ session: makeSession({ role: "owner" }) })
    world.people.push({ id: "never-asked", workspaceId: owner.workspaceId, status: "active" })
    const segmentsService = createMarketingSegmentsService({
      store: world.segmentsStore,
      audit: async () => undefined,
    })
    const segment = await segmentsService.create(owner, {
      name: "Everyone active",
      filter: {
        type: "group",
        id: "root",
        combinator: "and",
        children: [
          { type: "condition", id: "c1", field: "status", operator: "eq", value: "active" },
        ],
      },
    })
    const campaignsService = createMarketingCampaignsService({
      campaigns: world.campaignsStore,
      segments: world.segmentsStore,
      recipients: world.recipientsStore,
      queue: world.queue,
      audit: async () => undefined,
    })
    const campaign = await campaignsService.create(owner, {
      name: "Announce",
      subject: "Hi",
      segmentId: segment.id,
    })
    await campaignsService.send(owner, campaign.id)
    expect(world.recipients.list(owner.workspaceId)).toHaveLength(0)
  })

  test("send() requires send_external — a viewer is denied", async () => {
    const world = makeWorld()
    const owner = makeServiceContext({ session: makeSession({ role: "owner" }) })
    world.people.push({ id: "p1", workspaceId: owner.workspaceId, status: "active" })
    const segmentsService = createMarketingSegmentsService({
      store: world.segmentsStore,
      audit: async () => undefined,
    })
    const segment = await segmentsService.create(owner, {
      name: "Active",
      filter: { type: "group", id: "root", combinator: "and", children: [] },
    })
    const campaignsService = createMarketingCampaignsService({
      campaigns: world.campaignsStore,
      segments: world.segmentsStore,
      recipients: world.recipientsStore,
      queue: world.queue,
      audit: async () => undefined,
    })
    const campaign = await campaignsService.create(owner, {
      name: "A",
      subject: "S",
      segmentId: segment.id,
    })
    const viewer = makeServiceContext({
      session: makeSession({ role: "viewer", workspaceId: owner.workspaceId }),
    })
    const denied = await expectDenied(() => campaignsService.send(viewer, campaign.id))
    expect(denied.ctx.action).toBe("send_external")
    expect(world.enqueued).toHaveLength(0)

    // A member (>= the send_external threshold) is allowed.
    const member = makeServiceContext({
      session: makeSession({ role: "member", workspaceId: owner.workspaceId }),
    })
    await expectAllowed(() => campaignsService.send(member, campaign.id))
    expect(world.enqueued).toHaveLength(1)
  })

  test("send() is rejected on an already-sending/cancelled campaign", async () => {
    const world = makeWorld()
    const owner = makeServiceContext({ session: makeSession({ role: "owner" }) })
    const segmentsService = createMarketingSegmentsService({
      store: world.segmentsStore,
      audit: async () => undefined,
    })
    const segment = await segmentsService.create(owner, {
      name: "Active",
      filter: { type: "group", id: "root", combinator: "and", children: [] },
    })
    const campaignsService = createMarketingCampaignsService({
      campaigns: world.campaignsStore,
      segments: world.segmentsStore,
      recipients: world.recipientsStore,
      queue: world.queue,
      audit: async () => undefined,
    })
    const campaign = await campaignsService.create(owner, {
      name: "A",
      subject: "S",
      segmentId: segment.id,
    })
    await campaignsService.cancel(owner, campaign.id)
    await expect(campaignsService.send(owner, campaign.id)).rejects.toBeInstanceOf(
      MarketingCampaignStateError,
    )
  })
})

describe("marketing/batch idempotency: a retried BullMQ delivery re-sends nothing", () => {
  test("claiming twice after the first claim already succeeded finds nothing left pending", async () => {
    const world = makeWorld()
    const owner = makeServiceContext({ session: makeSession({ role: "owner" }) })
    world.people.push(
      { id: "p1", workspaceId: owner.workspaceId, status: "active" },
      { id: "p2", workspaceId: owner.workspaceId, status: "active" },
    )
    const consentService = createMarketingConsentService({
      store: world.consentStore,
      audit: async () => undefined,
    })
    await consentService.grant(owner, { personId: "p1", marketingConsent: true })
    await consentService.grant(owner, { personId: "p2", marketingConsent: true })
    const segmentsService = createMarketingSegmentsService({
      store: world.segmentsStore,
      audit: async () => undefined,
    })
    const segment = await segmentsService.create(owner, {
      name: "Active",
      filter: {
        type: "group",
        id: "root",
        combinator: "and",
        children: [
          { type: "condition", id: "c1", field: "status", operator: "eq", value: "active" },
        ],
      },
    })
    const campaignsService = createMarketingCampaignsService({
      campaigns: world.campaignsStore,
      segments: world.segmentsStore,
      recipients: world.recipientsStore,
      queue: world.queue,
      audit: async () => undefined,
    })
    const campaign = await campaignsService.create(owner, {
      name: "A",
      subject: "S",
      segmentId: segment.id,
    })
    await campaignsService.send(owner, campaign.id)

    const batchService = createMarketingBatchService({
      campaigns: world.campaignsStore,
      recipients: world.recipientsStore,
      sender: world.sender,
      audit: async () => undefined,
    })

    // First delivery of the BullMQ job: claims and sends both.
    const first = await batchService.sendBatch(owner.workspaceId, campaign.id, 50)
    expect(first).toEqual({ claimed: 2, sent: 2, failed: 0, remainingPending: 0 })
    expect(world.sent).toHaveLength(2)

    // RETRY: BullMQ redelivers the identical job (at-least-once semantics).
    const retry = await batchService.sendBatch(owner.workspaceId, campaign.id, 50)
    expect(retry).toEqual({ claimed: 0, sent: 0, failed: 0, remainingPending: 0 })
    // No new sends happened — the sender was not invoked again.
    expect(world.sent).toHaveLength(2)

    const finalCampaign = await world.campaignsStore.findById(owner.workspaceId, campaign.id)
    expect(finalCampaign?.status).toBe("sent")
    expect(finalCampaign?.sentCount).toBe(2)
  })

  test("a failed send does not block other recipients or get re-claimed", async () => {
    const world = makeWorld()
    const owner = makeServiceContext({ session: makeSession({ role: "owner" }) })
    world.people.push(
      { id: "ok", workspaceId: owner.workspaceId, status: "active" },
      { id: "bad", workspaceId: owner.workspaceId, status: "active" },
    )
    const consentService = createMarketingConsentService({
      store: world.consentStore,
      audit: async () => undefined,
    })
    await consentService.grant(owner, { personId: "ok", marketingConsent: true })
    await consentService.grant(owner, { personId: "bad", marketingConsent: true })
    const segmentsService = createMarketingSegmentsService({
      store: world.segmentsStore,
      audit: async () => undefined,
    })
    const segment = await segmentsService.create(owner, {
      name: "Active",
      filter: {
        type: "group",
        id: "root",
        combinator: "and",
        children: [
          { type: "condition", id: "c1", field: "status", operator: "eq", value: "active" },
        ],
      },
    })
    const campaignsService = createMarketingCampaignsService({
      campaigns: world.campaignsStore,
      segments: world.segmentsStore,
      recipients: world.recipientsStore,
      queue: world.queue,
      audit: async () => undefined,
    })
    const campaign = await campaignsService.create(owner, {
      name: "A",
      subject: "S",
      segmentId: segment.id,
    })
    await campaignsService.send(owner, campaign.id)

    const failingSender: MarketingCampaignSenderPort = {
      send: async (input) => {
        if (input.personId === "bad") return { outcome: "failed", reason: "bounced" }
        return { outcome: "sent", emailMessageId: "m1" }
      },
    }
    const batchService = createMarketingBatchService({
      campaigns: world.campaignsStore,
      recipients: world.recipientsStore,
      sender: failingSender,
      audit: async () => undefined,
    })
    const result = await batchService.sendBatch(owner.workspaceId, campaign.id, 50)
    expect(result.sent).toBe(1)
    expect(result.failed).toBe(1)
    const finalCampaign = await world.campaignsStore.findById(owner.workspaceId, campaign.id)
    expect(finalCampaign?.sentCount).toBe(1)
    expect(finalCampaign?.failedCount).toBe(1)
    expect(finalCampaign?.status).toBe("sent")
  })
})

describe("marketing/consent", () => {
  test("unsubscribeByToken needs no session — possession of the token is the authorization", async () => {
    const world = makeWorld()
    const owner = makeServiceContext({ session: makeSession({ role: "owner" }) })
    const consentService = createMarketingConsentService({
      store: world.consentStore,
      audit: async () => undefined,
    })
    const granted = await consentService.grant(owner, { personId: "p1", marketingConsent: true })
    expect(granted.marketingConsent).toBe(true)

    const updated = await consentService.unsubscribeByToken(String(granted.unsubscribeToken))
    expect(updated.marketingConsent).toBe(false)
    expect(updated.unsubscribedAt).not.toBeNull()
  })

  test("an unknown token is NOT_FOUND", async () => {
    const world = makeWorld()
    const consentService = createMarketingConsentService({
      store: world.consentStore,
      audit: async () => undefined,
    })
    await expect(consentService.unsubscribeByToken("no-such-token")).rejects.toBeInstanceOf(
      MarketingConsentNotFoundError,
    )
  })
})
