import { beforeEach, describe, expect, test } from "bun:test"
import { createEvent, CrmEvents, EventBus, type DomainEvent } from "@yourcrm/events"
import { PermissionDeniedError } from "@yourcrm/permissions"
import { makeServiceContext } from "@yourcrm/testing"
import {
  createApiWebhooksService,
  subscribeWebhookDispatcher,
  WebhookSubscriptionNotFoundError,
  type ApiWebhooksService,
} from "./service"
import { roleExceedsCeiling } from "./api-keys"
import { WebhookEvents } from "./event-names"
import { WEBHOOK_AUTO_DISABLE_AFTER, WEBHOOK_MAX_ATTEMPTS, webhookBackoffMs } from "./retry"
import { signWebhookDelivery, WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER } from "./signing"
import type {
  ApiWebhooksAuditInput,
  PublicApiKeyRecord,
  WebhookDeliveryJobRequest,
  WebhookDeliveryRecord,
  WebhookSubscriptionRecord,
  WebhookTransportRequest,
  WebhookTransportResponse,
} from "./types"

/**
 * Hermetic: no Postgres, no Redis, no socket and no resolver. Every port is
 * an in-memory double, so the tests below assert the module's decisions
 * rather than the network's mood (`docs/conventions.md`).
 */

const WORKSPACE = "ws_hooks"
const TARGET = "https://hooks.example.com/yourcrm"

type Harness = ReturnType<typeof makeHarness>

function makeHarness(
  options: {
    transport?: (request: WebhookTransportRequest) => Promise<WebhookTransportResponse>
    resolved?: string[]
  } = {},
) {
  let sequence = 0
  const nextId = (prefix: string) => `${prefix}_${(sequence += 1)}`
  const clock = { at: new Date("2026-01-01T00:00:00.000Z") }

  const subscriptions = new Map<string, WebhookSubscriptionRecord>()
  const secrets = new Map<string, string>()
  const deliveries = new Map<string, WebhookDeliveryRecord>()
  const keys = new Map<string, PublicApiKeyRecord & { keyHash: string }>()

  const audits: ApiWebhooksAuditInput[] = []
  const enqueued: WebhookDeliveryJobRequest[] = []
  const sent: WebhookTransportRequest[] = []
  const bus = new EventBus()
  const emitted: DomainEvent[] = []
  bus.on("*", (event) => {
    emitted.push(event)
  })

  const hash = (value: string) => `sha256:${value}`
  /** Strip the stored digest: a key record never carries key material. */
  const publicKeyOf = (row: PublicApiKeyRecord & { keyHash: string }): PublicApiKeyRecord => {
    const copy: Record<string, unknown> = { ...row }
    delete copy.keyHash
    return copy as PublicApiKeyRecord
  }

  const service = createApiWebhooksService({
    now: () => clock.at,
    events: bus,
    audit: async (input) => {
      audits.push(input)
    },
    resolveDns: async () => options.resolved ?? ["93.184.216.34"],
    transport: async (request) => {
      sent.push(request)
      if (options.transport) return options.transport(request)
      return { statusCode: 200, bodySnippet: "ok" }
    },
    queue: {
      enqueueWebhookDelivery: async (request) => {
        enqueued.push(request)
      },
    },
    store: {
      list: async (workspaceId, query) => {
        const rows = [...subscriptions.values()].filter(
          (row) =>
            row.workspaceId === workspaceId &&
            (query.active === undefined || row.active === query.active) &&
            (query.event === undefined || row.eventNames.includes(query.event)),
        )
        return { data: rows, pagination: { nextCursor: null, limit: query.limit ?? 25 } }
      },
      findById: async (workspaceId, id) => {
        const row = subscriptions.get(id)
        return row && row.workspaceId === workspaceId ? { ...row } : null
      },
      findActiveForEvent: async (workspaceId, eventName) =>
        [...subscriptions.values()]
          .filter(
            (row) =>
              row.workspaceId === workspaceId && row.active && row.eventNames.includes(eventName),
          )
          .map((row) => ({ ...row })),
      create: async (workspaceId, input, actorId) => {
        const id = nextId("sub")
        const row: WebhookSubscriptionRecord = {
          id,
          workspaceId,
          name: input.name,
          description: input.description ?? null,
          targetUrl: input.targetUrl,
          eventNames: input.eventNames,
          active: input.active,
          // The store seals the secret; the record it returns cannot carry
          // one, exactly like the repository.
          secretHint: `whsec_…${input.secret.slice(-4)}`,
          consecutiveFailures: 0,
          createdBy: actorId ?? null,
        }
        subscriptions.set(id, row)
        secrets.set(id, input.secret)
        return { ...row }
      },
      update: async (workspaceId, id, patch) => {
        const row = subscriptions.get(id)
        if (!row || row.workspaceId !== workspaceId) return null
        const next = { ...row, ...patch } as WebhookSubscriptionRecord
        subscriptions.set(id, next)
        return { ...next }
      },
      rotateSecret: async (workspaceId, id, secret) => {
        const row = subscriptions.get(id)
        if (!row || row.workspaceId !== workspaceId) return null
        const next = { ...row, secretHint: `whsec_…${secret.slice(-4)}` }
        subscriptions.set(id, next)
        secrets.set(id, secret)
        return { ...next }
      },
      readSecret: async (id) => secrets.get(id) ?? null,
      softDelete: async (workspaceId, id) => {
        const row = subscriptions.get(id)
        if (row && row.workspaceId === workspaceId) subscriptions.delete(id)
      },
      recordOutcome: async (id, outcome) => {
        const row = subscriptions.get(id)
        if (!row) return { consecutiveFailures: 0 }
        const previous = Number(row.consecutiveFailures ?? 0)
        const consecutiveFailures = outcome.failed ? previous + 1 : 0
        subscriptions.set(id, {
          ...row,
          consecutiveFailures,
          lastDeliveryAt: outcome.at,
          lastDeliveryStatus: outcome.status,
        })
        return { consecutiveFailures }
      },
    },
    deliveries: {
      list: async (workspaceId, query) => {
        const rows = [...deliveries.values()].filter(
          (row) =>
            row.workspaceId === workspaceId &&
            (query.subscriptionId === undefined || row.subscriptionId === query.subscriptionId) &&
            (query.status === undefined || row.status === query.status),
        )
        return { data: rows, pagination: { nextCursor: null, limit: query.limit ?? 25 } }
      },
      findById: async (workspaceId, id) => {
        const row = deliveries.get(id)
        return row && row.workspaceId === workspaceId ? { ...row } : null
      },
      findForDelivery: async (id) => {
        const row = deliveries.get(id)
        return row ? { ...row } : null
      },
      createIfAbsent: async (workspaceId, input) => {
        // Stands in for the UNIQUE (subscription_id, event_id) index.
        const existing = [...deliveries.values()].find(
          (row) => row.subscriptionId === input.subscriptionId && row.eventId === input.eventId,
        )
        if (existing) return { delivery: { ...existing }, created: false }
        const id = nextId("dlv")
        const row: WebhookDeliveryRecord = {
          id,
          workspaceId,
          subscriptionId: input.subscriptionId,
          eventId: input.eventId,
          eventName: input.eventName,
          status: "pending",
          body: input.body,
          attemptCount: 0,
          maxAttempts: input.maxAttempts,
          attempts: [],
          replayOfId: input.replayOfId ?? null,
        }
        deliveries.set(id, row)
        return { delivery: { ...row }, created: true }
      },
      claim: async (id) => {
        const row = deliveries.get(id)
        if (!row) return null
        if (row.status !== "pending" && row.status !== "failed") return null
        const next = {
          ...row,
          status: "delivering",
          attemptCount: row.attemptCount + 1,
        } as WebhookDeliveryRecord
        deliveries.set(id, next)
        return { ...next }
      },
      recordAttempt: async (id, input) => {
        const row = deliveries.get(id)
        if (!row) return null
        const attempts = [...((row.attempts as unknown[]) ?? []), input.attempt]
        const next = {
          ...row,
          status: input.status,
          attempts,
          nextAttemptAt: input.nextAttemptAt,
          deadLetterReason: input.deadLetterReason,
          lastStatusCode: input.attempt.statusCode,
          lastResponseSnippet: input.attempt.responseSnippet,
          lastDurationMs: input.attempt.durationMs,
          lastError: input.attempt.error,
        } as WebhookDeliveryRecord
        deliveries.set(id, next)
        return { ...next }
      },
    },
    apiKeys: {
      list: async (workspaceId, query) => ({
        data: [...keys.values()].filter((row) => row.workspaceId === workspaceId).map(publicKeyOf),
        pagination: { nextCursor: null, limit: query.limit ?? 25 },
      }),
      findById: async (workspaceId, id) => {
        const row = keys.get(id)
        if (!row || row.workspaceId !== workspaceId) return null
        return publicKeyOf(row)
      },
      create: async (workspaceId, input, actorId) => {
        const id = nextId("key")
        const row = {
          id,
          workspaceId,
          name: input.name,
          role: input.role,
          keyPrefix: input.keyPrefix,
          lastFour: input.lastFour,
          expiresAt: input.expiresAt ?? null,
          revokedAt: null,
          createdBy: actorId ?? null,
          // Only the hash is kept — there is no column for the key itself.
          keyHash: hash(input.rawKey),
        }
        keys.set(id, row)
        return publicKeyOf(row)
      },
      findByRawKey: async (rawKey, at) => {
        const row = [...keys.values()].find((candidate) => candidate.keyHash === hash(rawKey))
        if (!row || row.revokedAt !== null) return null
        const expiresAt = row.expiresAt as Date | null
        if (expiresAt && expiresAt.getTime() <= at.getTime()) return null
        return {
          id: row.id,
          workspaceId: row.workspaceId,
          name: row.name,
          role: row.role,
          createdBy: (row.createdBy as string | null) ?? null,
          expiresAt,
        }
      },
      touchLastUsed: async (id, at) => {
        const row = keys.get(id)
        if (row) keys.set(id, { ...row, lastUsedAt: at })
      },
      revoke: async (workspaceId, id) => {
        const row = keys.get(id)
        if (!row || row.workspaceId !== workspaceId) return null
        const next = { ...row, revokedAt: clock.at }
        keys.set(id, next)
        return publicKeyOf(next)
      },
    },
  })

  return {
    service,
    audits,
    enqueued,
    sent,
    emitted,
    bus,
    clock,
    deliveries,
    subscriptions,
    secrets,
  }
}

const ownerCtx = () => makeServiceContext({ workspaceId: WORKSPACE, actorId: "u_1", role: "owner" })
const viewerCtx = () =>
  makeServiceContext({ workspaceId: WORKSPACE, actorId: "u_2", role: "viewer" })

async function seedSubscription(
  h: Harness,
  overrides: Partial<{ eventNames: string[]; targetUrl: string; name: string }> = {},
) {
  return h.service.createSubscription(ownerCtx(), {
    name: overrides.name ?? "Ops relay",
    targetUrl: overrides.targetUrl ?? TARGET,
    eventNames: overrides.eventNames ?? [CrmEvents.PersonCreated],
  })
}

function personCreated(eventId: string): DomainEvent {
  return {
    ...createEvent({
      event: CrmEvents.PersonCreated,
      workspaceId: WORKSPACE,
      actorId: "u_1",
      entityType: "person",
      entityId: "p_1",
      after: { id: "p_1", firstName: "Ada" },
    }),
    eventId,
  }
}

/* ------------------------------------------------------------------ */

describe("api-webhooks/subscriptions", () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })

  test("a subscription is created, audited, and reveals its secret exactly once", async () => {
    const created = await seedSubscription(h)
    expect(created.subscription.targetUrl).toBe(TARGET)
    expect(created.subscription.eventNames).toEqual([CrmEvents.PersonCreated])
    expect(created.signingSecret.startsWith("whsec_")).toBe(true)
    expect(h.audits.at(-1)?.action).toBe("create")
    expect(h.audits.at(-1)?.object).toBe("webhook_subscription")
  })

  test("SECRETS NEVER LEAVE: no read path returns a signing secret", async () => {
    const created = await seedSubscription(h)
    const secret = created.signingSecret

    const fetched = await h.service.getSubscription(ownerCtx(), created.subscription.id)
    const listed = await h.service.listSubscriptions(ownerCtx(), {})
    const updated = await h.service.updateSubscription(ownerCtx(), created.subscription.id, {
      name: "Renamed",
    })

    for (const payload of [fetched, listed, updated]) {
      expect(JSON.stringify(payload)).not.toContain(secret)
    }
    // Only the masked hint survives into a response.
    expect(String(fetched.secretHint)).toBe(`whsec_…${secret.slice(-4)}`)
    // The audit trail cannot carry one either.
    expect(JSON.stringify(h.audits)).not.toContain(secret)
  })

  test("rotation issues a NEW secret and never echoes the old one", async () => {
    const created = await seedSubscription(h)
    const rotated = await h.service.rotateSigningSecret(ownerCtx(), created.subscription.id)
    expect(rotated.signingSecret).not.toBe(created.signingSecret)
    expect(JSON.stringify(rotated.subscription)).not.toContain(created.signingSecret)
    expect(JSON.stringify(rotated.subscription)).not.toContain(rotated.signingSecret)
    expect(h.audits.at(-1)?.action).toBe("rotate_secret")
  })

  test("SSRF: a blocked target is refused at save time, on create and on update", async () => {
    for (const targetUrl of ["http://localhost", "http://169.254.169.254/", "http://10.0.0.1"]) {
      await expect(seedSubscription(h, { targetUrl })).rejects.toThrow()
    }
    for (const targetUrl of ["https://localhost", "https://169.254.169.254/", "https://10.0.0.1"]) {
      await expect(seedSubscription(h, { targetUrl })).rejects.toThrow()
    }
    const created = await seedSubscription(h)
    await expect(
      h.service.updateSubscription(ownerCtx(), created.subscription.id, {
        targetUrl: "https://169.254.169.254/",
      }),
    ).rejects.toThrow()
  })

  test("an unknown event name is rejected; the catalogue is @yourcrm/events", async () => {
    await expect(seedSubscription(h, { eventNames: ["person.exploded"] })).rejects.toThrow()
    await expect(
      seedSubscription(h, { eventNames: [WebhookEvents.DeliveryFailed] }),
    ).rejects.toThrow()
  })

  test("PERMISSIONS: a viewer is denied reads and writes alike", async () => {
    await expect(h.service.listSubscriptions(viewerCtx(), {})).rejects.toThrow(
      PermissionDeniedError,
    )
    await expect(seedSubscription({ ...h, service: viewerService(h) })).rejects.toThrow(
      PermissionDeniedError,
    )
  })

  test("deleting an unknown subscription is a typed 404, not a silent success", async () => {
    await expect(h.service.deleteSubscription(ownerCtx(), "sub_missing")).rejects.toThrow(
      WebhookSubscriptionNotFoundError,
    )
  })
})

function viewerService(h: Harness): ApiWebhooksService {
  // `seedSubscription` always uses an owner context, so the viewer path
  // needs the same service with a different caller.
  return {
    ...h.service,
    createSubscription: (_ctx, input) => h.service.createSubscription(viewerCtx(), input),
  }
}

describe("api-webhooks/dispatch", () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })

  test("a matching event queues one delivery per active subscription", async () => {
    const a = await seedSubscription(h, { name: "A" })
    await seedSubscription(h, { name: "B" })
    await seedSubscription(h, { name: "C", eventNames: [CrmEvents.DealWon] })

    const result = await h.service.dispatch(personCreated("evt_1"))
    expect(result.matched).toBe(2)
    expect(result.enqueued).toBe(2)
    expect(result.duplicates).toBe(0)
    expect(h.enqueued).toHaveLength(2)
    expect(h.enqueued[0]?.attempt).toBe(1)
    expect(h.enqueued.some((job) => job.subscriptionId === a.subscription.id)).toBe(true)
    // Nothing is delivered inline — dispatch only enqueues.
    expect(h.sent).toHaveLength(0)
  })

  test("IDEMPOTENCY: a redelivered event creates no second delivery", async () => {
    await seedSubscription(h)
    const event = personCreated("evt_dup")

    const first = await h.service.dispatch(event)
    const second = await h.service.dispatch(event)

    expect(first.enqueued).toBe(1)
    expect(second.enqueued).toBe(0)
    expect(second.duplicates).toBe(1)
    expect(h.enqueued).toHaveLength(1)
  })

  test("inactive subscriptions, other workspaces and unknown names are ignored", async () => {
    const created = await seedSubscription(h)
    await h.service.updateSubscription(ownerCtx(), created.subscription.id, { active: false })
    expect((await h.service.dispatch(personCreated("evt_2"))).matched).toBe(0)

    await h.service.updateSubscription(ownerCtx(), created.subscription.id, { active: true })
    const foreign = { ...personCreated("evt_3"), workspaceId: "ws_other" }
    expect((await h.service.dispatch(foreign)).matched).toBe(0)
  })

  test("FEEDBACK LOOP: this module's own events never dispatch", async () => {
    await seedSubscription(h)
    const own = createEvent({
      event: WebhookEvents.DeliveryFailed,
      workspaceId: WORKSPACE,
      entityType: "webhook_delivery",
      entityId: "dlv_1",
    })
    const result = await h.service.dispatch(own)
    expect(result.matched).toBe(0)
    expect(h.enqueued).toHaveLength(0)
  })

  test("the bus subscription never fails the write that triggered it", async () => {
    const errors: unknown[] = []
    const bus = new EventBus()
    const unsubscribe = subscribeWebhookDispatcher(
      bus,
      {
        dispatch: async () => {
          throw new Error("store is down")
        },
      },
      (err) => errors.push(err),
    )
    await bus.emit(personCreated("evt_boom"))
    expect(errors).toHaveLength(1)
    unsubscribe()
  })
})

describe("api-webhooks/delivery", () => {
  test("a 2xx signs the body, settles as succeeded and emits the event", async () => {
    const h = makeHarness()
    const created = await seedSubscription(h)
    await h.service.dispatch(personCreated("evt_ok"))
    const job = h.enqueued[0]
    if (!job) throw new Error("expected a queued delivery")

    const result = await h.service.executeDelivery(job)
    expect(result.status).toBe("succeeded")
    expect(result.statusCode).toBe(200)

    const request = h.sent[0]
    if (!request) throw new Error("expected one transport call")
    expect(request.url).toBe(TARGET)
    expect(request.headers[WEBHOOK_TIMESTAMP_HEADER]).toBe(
      String(Math.floor(h.clock.at.getTime() / 1000)),
    )
    expect(request.headers[WEBHOOK_SIGNATURE_HEADER]).toBe(
      signWebhookDelivery({
        secret: created.signingSecret,
        body: request.body,
        timestamp: Math.floor(h.clock.at.getTime() / 1000),
      }),
    )
    // The signed body is the canonical envelope, and carries no secret.
    expect(JSON.parse(request.body)).toMatchObject({ event: CrmEvents.PersonCreated })
    expect(request.body).not.toContain(created.signingSecret)

    expect(h.emitted.map((e) => e.event)).toContain(WebhookEvents.DeliverySucceeded)
  })

  test("IDEMPOTENCY: re-running the same job does not deliver twice", async () => {
    const h = makeHarness()
    await seedSubscription(h)
    await h.service.dispatch(personCreated("evt_once"))
    const job = h.enqueued[0]
    if (!job) throw new Error("expected a queued delivery")

    const first = await h.service.executeDelivery(job)
    const second = await h.service.executeDelivery(job)
    const third = await h.service.executeDelivery(job)

    expect(first.status).toBe("succeeded")
    expect(second.status).toBe("skipped")
    expect(third.status).toBe("skipped")
    // The property that matters: exactly one HTTP request happened.
    expect(h.sent).toHaveLength(1)
  })

  test("TRANSIENT: a 503 retries with backoff and dead-letters at the ceiling", async () => {
    const h = makeHarness({ transport: async () => ({ statusCode: 503, bodySnippet: "busy" }) })
    await seedSubscription(h)
    await h.service.dispatch(personCreated("evt_503"))

    const outcomes: string[] = []
    let job = h.enqueued[0]
    for (let i = 0; i < WEBHOOK_MAX_ATTEMPTS; i += 1) {
      if (!job) throw new Error(`expected a queued attempt ${i + 1}`)
      const result = await h.service.executeDelivery(job)
      outcomes.push(result.status)
      if (result.status === "failed") {
        expect(result.retryInMs).toBe(webhookBackoffMs(i + 1))
        job = h.enqueued.at(-1)
        expect(job?.attempt).toBe(i + 2)
      }
    }

    expect(outcomes.slice(0, WEBHOOK_MAX_ATTEMPTS - 1).every((s) => s === "failed")).toBe(true)
    expect(outcomes.at(-1)).toBe("dead_lettered")
    expect(h.sent).toHaveLength(WEBHOOK_MAX_ATTEMPTS)

    // Every attempt is recorded with its status code, snippet and duration.
    const delivery = [...h.deliveries.values()][0]
    const attempts = delivery?.attempts as { statusCode: number; responseSnippet: string }[]
    expect(attempts).toHaveLength(WEBHOOK_MAX_ATTEMPTS)
    expect(attempts[0]?.statusCode).toBe(503)
    expect(attempts[0]?.responseSnippet).toBe("busy")

    expect(h.emitted.map((e) => e.event)).toContain(WebhookEvents.DeliveryFailed)
    expect(h.audits.some((a) => a.action === "dead_letter")).toBe(true)
  })

  test("PERMANENT: a 404 dead-letters on the first attempt", async () => {
    const h = makeHarness({ transport: async () => ({ statusCode: 404, bodySnippet: "nope" }) })
    await seedSubscription(h)
    await h.service.dispatch(personCreated("evt_404"))
    const job = h.enqueued[0]
    if (!job) throw new Error("expected a queued delivery")

    const result = await h.service.executeDelivery(job)
    expect(result.status).toBe("dead_lettered")
    expect(result.reason).toContain("permanent")
    // One attempt, and no retry queued behind it.
    expect(h.sent).toHaveLength(1)
    expect(h.enqueued).toHaveLength(1)
  })

  test("a network error (no HTTP response) is transient, not permanent", async () => {
    const h = makeHarness({
      transport: async () => {
        throw new Error("ECONNRESET")
      },
    })
    await seedSubscription(h)
    await h.service.dispatch(personCreated("evt_reset"))
    const job = h.enqueued[0]
    if (!job) throw new Error("expected a queued delivery")

    const result = await h.service.executeDelivery(job)
    expect(result.status).toBe("failed")
    expect(result.retryInMs).toBe(webhookBackoffMs(1))
  })

  test("SSRF: a target that now resolves privately is dead-lettered, never fetched", async () => {
    // Saved while the name resolved publicly; by delivery time it points
    // at the metadata endpoint. The re-check must stop it here.
    const h = makeHarness({ resolved: ["169.254.169.254"] })
    await seedSubscription(h)
    await h.service.dispatch(personCreated("evt_rebind"))
    const job = h.enqueued[0]
    if (!job) throw new Error("expected a queued delivery")

    const result = await h.service.executeDelivery(job)
    expect(result.status).toBe("dead_lettered")
    expect(result.reason).toContain("169.254.0.0/16")
    expect(h.sent).toHaveLength(0)
  })

  test("a subscription that is disabled or gone dead-letters without a request", async () => {
    const h = makeHarness()
    const created = await seedSubscription(h)
    await h.service.dispatch(personCreated("evt_off"))
    const job = h.enqueued[0]
    if (!job) throw new Error("expected a queued delivery")
    await h.service.updateSubscription(ownerCtx(), created.subscription.id, { active: false })

    const result = await h.service.executeDelivery(job)
    expect(result.status).toBe("dead_lettered")
    expect(result.reason).toContain("inactive")
    expect(h.sent).toHaveLength(0)
  })

  test("a persistently dead subscriber is auto-disabled", async () => {
    const h = makeHarness({ transport: async () => ({ statusCode: 410, bodySnippet: "gone" }) })
    const created = await seedSubscription(h)
    for (let i = 0; i < WEBHOOK_AUTO_DISABLE_AFTER; i += 1) {
      await h.service.dispatch(personCreated(`evt_gone_${i}`))
      const job = h.enqueued.at(-1)
      if (!job) throw new Error("expected a queued delivery")
      await h.service.executeDelivery(job)
    }
    const subscription = h.subscriptions.get(created.subscription.id)
    expect(subscription?.active).toBe(false)
    expect(String(subscription?.disabledReason)).toContain("auto-disabled")
    expect(h.audits.some((a) => a.action === "auto_disable")).toBe(true)
  })

  test("replay creates a NEW delivery linked to the original and re-queues it", async () => {
    const h = makeHarness()
    await seedSubscription(h)
    await h.service.dispatch(personCreated("evt_replay"))
    const job = h.enqueued[0]
    if (!job) throw new Error("expected a queued delivery")
    await h.service.executeDelivery(job)

    const replay = await h.service.replayDelivery(ownerCtx(), job.deliveryId)
    expect(replay.id).not.toBe(job.deliveryId)
    expect(replay.replayOfId).toBe(job.deliveryId)
    expect(replay.eventId.startsWith("evt_replay:replay:")).toBe(true)
    expect(replay.status).toBe("pending")
    expect(h.enqueued.at(-1)?.deliveryId).toBe(replay.id)
    expect(h.audits.at(-1)?.action).toBe("replay")

    // The original's attempt history survives — it is the evidence.
    const original = await h.service.getDelivery(ownerCtx(), job.deliveryId)
    expect((original.attempts as unknown[]).length).toBe(1)
  })

  test("PERMISSIONS: a viewer cannot read the delivery log or replay", async () => {
    const h = makeHarness()
    await seedSubscription(h)
    await expect(h.service.listDeliveries(viewerCtx(), {})).rejects.toThrow(PermissionDeniedError)
    await expect(h.service.replayDelivery(viewerCtx(), "dlv_1")).rejects.toThrow(
      PermissionDeniedError,
    )
  })
})

describe("api-webhooks/api-keys", () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })

  test("a key is returned once at creation and never again", async () => {
    const created = await h.service.createApiKey(ownerCtx(), { name: "CI", role: "member" })
    expect(created.key.startsWith("ycrm_sk_")).toBe(true)
    expect(created.apiKey.lastFour).toBe(created.key.slice(-4))

    const listed = await h.service.listApiKeys(ownerCtx(), {})
    expect(JSON.stringify(listed)).not.toContain(created.key)
    // Nor through the event or the audit trail.
    expect(JSON.stringify(h.emitted)).not.toContain(created.key)
    expect(JSON.stringify(h.audits)).not.toContain(created.key)
    expect(h.emitted.map((e) => e.event)).toContain(WebhookEvents.ApiKeyCreated)
  })

  test("a key resolves to its workspace and role, and stops resolving once revoked", async () => {
    const created = await h.service.createApiKey(ownerCtx(), { name: "CI", role: "viewer" })
    const resolved = await h.service.resolveApiKey(created.key)
    expect(resolved?.workspaceId).toBe(WORKSPACE)
    expect(resolved?.role).toBe("viewer")
    expect(resolved?.createdBy).toBe("u_1")

    await h.service.revokeApiKey(ownerCtx(), created.apiKey.id)
    expect(await h.service.resolveApiKey(created.key)).toBeNull()
  })

  test("unknown, malformed and expired keys all resolve to null", async () => {
    expect(await h.service.resolveApiKey("")).toBeNull()
    expect(await h.service.resolveApiKey("Bearer something")).toBeNull()
    expect(await h.service.resolveApiKey(`ycrm_sk_${"a".repeat(43)}`)).toBeNull()

    const expired = await h.service.createApiKey(ownerCtx(), {
      name: "Old",
      role: "viewer",
      expiresAt: new Date("2025-01-01T00:00:00.000Z"),
    })
    expect(await h.service.resolveApiKey(expired.key)).toBeNull()
  })

  test("A KEY CANNOT EXCEED ITS CREATOR (spec 32 §8)", async () => {
    // The ceiling is derived from `@yourcrm/permissions`, not from a second
    // rank table here — see `roleExceedsCeiling`. Under today's policy
    // `owner` and `admin` allow exactly the same actions, so an admin
    // minting an "owner" key escalates nothing and is allowed; the check
    // starts refusing it the moment the shared policy separates them.
    expect(roleExceedsCeiling("admin", "member")).toBe(true)
    expect(roleExceedsCeiling("member", "viewer")).toBe(true)
    expect(roleExceedsCeiling("admin", "viewer")).toBe(true)
    expect(roleExceedsCeiling("viewer", "member")).toBe(false)
    expect(roleExceedsCeiling("member", "member")).toBe(false)

    const adminCtx = makeServiceContext({ workspaceId: WORKSPACE, actorId: "u_3", role: "admin" })
    await expect(
      h.service.createApiKey(adminCtx, { name: "Fine", role: "member" }),
    ).resolves.toBeDefined()

    // The refusal itself, exercised through the service with a creator the
    // policy does rank below the requested role.
    const stunted = makeServiceContext({ workspaceId: WORKSPACE, actorId: "u_4", role: "admin" })
    await expect(
      h.service.createApiKey({ ...stunted, role: "member" }, { name: "Escalation", role: "admin" }),
    ).rejects.toThrow(PermissionDeniedError)
  })

  test("PERMISSIONS: a viewer cannot list, create or revoke keys", async () => {
    await expect(h.service.listApiKeys(viewerCtx(), {})).rejects.toThrow(PermissionDeniedError)
    await expect(
      h.service.createApiKey(viewerCtx(), { name: "Nope", role: "viewer" }),
    ).rejects.toThrow(PermissionDeniedError)
    await expect(h.service.revokeApiKey(viewerCtx(), "key_1")).rejects.toThrow(
      PermissionDeniedError,
    )
  })
})
