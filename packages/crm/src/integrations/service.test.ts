import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { EventBus } from "@yourcrm/events"
import {
  captureEvents,
  createStore,
  expectDenied,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
  type CapturedEvents,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { z } from "zod"
import { IntegrationEvents } from "./event-names"
import { createGenericWebhookIntegrationProvider } from "./generic-webhook-provider"
import {
  createIntegrationsService,
  IntegrationConnectFailedError,
  IntegrationConnectionNotFoundError,
  IntegrationOAuthNotSupportedError,
  IntegrationProviderNotRegisteredError,
  IntegrationWebhookHandlerError,
  redactIntegrationSecrets,
  type IntegrationsService,
} from "./service"
import {
  createIntegrationProviderCatalog,
  type IntegrationAuditInput,
  type IntegrationConnectionRecord,
  type IntegrationCredentialKindValue,
  type IntegrationCredentialMetadataRecord,
  type IntegrationProviderPort,
  type IntegrationWebhookEventRecord,
} from "./types"
import { IntegrationSignatureError, signIntegrationWebhookBody } from "./webhook-signature"

const API_KEY = "sk-live-0123456789abcdef4f2a"
const WEBHOOK_SECRET = "whsec_0123456789abcdef0123456789"

type StoredConnection = BaseRecord & Record<string, unknown>

/** Webhook lookup is workspace-blind by design; the fake mirrors that. */
const allConnections = new Map<string, StoredConnection>()

type Harness = {
  service: IntegrationsService
  events: CapturedEvents
  audits: IntegrationAuditInput[]
  secrets: Map<string, string>
  webhookRows: (IntegrationWebhookEventRecord & { payload: unknown })[]
  handled: unknown[]
  connections: ReturnType<typeof createStore<StoredConnection>>
}

function maskFake(secret: string): string {
  return secret.length < 12 ? "••••" : `${secret.slice(0, 3)}…${secret.slice(-4)}`
}

type HarnessOptions = {
  providers?: IntegrationProviderPort[]
  handlerThrows?: boolean
}

/** Real domain service over hermetic in-memory stores. */
function makeHarness(options: HarnessOptions = {}): Harness {
  const connections = createStore<StoredConnection>()
  const secrets = new Map<string, string>()
  const credentialRows = new Map<string, IntegrationCredentialMetadataRecord>()
  const webhookRows: (IntegrationWebhookEventRecord & { payload: unknown })[] = []
  const audits: IntegrationAuditInput[] = []
  const handled: unknown[] = []
  const bus = new EventBus()
  const events = captureEvents(bus)
  const slot = (connectionId: string, kind: string) => `${connectionId}:${kind}`

  const providers = options.providers ?? [
    createGenericWebhookIntegrationProvider({
      onDelivery: async (payload) => {
        if (options.handlerThrows) throw new Error(`boom while handling ${API_KEY}`)
        handled.push(payload)
      },
    }),
  ]

  const service = createIntegrationsService({
    providers: createIntegrationProviderCatalog(providers),
    store: {
      list: async (workspaceId, query) => {
        const rows = connections.list(workspaceId).filter((row) => {
          if (query.providerId && row.providerId !== query.providerId) return false
          if (query.status && row.status !== query.status) return false
          return true
        })
        const limit = query.limit ?? 25
        return {
          data: rows.slice(0, limit) as unknown as IntegrationConnectionRecord[],
          pagination: { nextCursor: null, limit },
        }
      },
      findById: async (workspaceId, id) =>
        connections.get(id, workspaceId) as IntegrationConnectionRecord | null,
      findForWebhook: async (id) =>
        (allConnections.get(id) as IntegrationConnectionRecord | undefined) ?? null,
      create: async (workspaceId, input, actorId) => {
        const row = connections.insert({
          ...makeBaseRecord({ workspaceId, createdBy: actorId, updatedBy: actorId }),
          ...input,
        })
        allConnections.set(row.id, row)
        return row as unknown as IntegrationConnectionRecord
      },
      update: async (workspaceId, id, patch) => {
        const row = connections.update(id, workspaceId, patch)
        if (row) allConnections.set(row.id, row)
        return (row as IntegrationConnectionRecord | null) ?? null
      },
      softDelete: async (workspaceId, id) => {
        connections.remove(id, workspaceId)
        allConnections.delete(id)
      },
    },
    credentials: {
      put: async (workspaceId, input) => {
        secrets.set(slot(input.connectionId, input.kind), input.secret)
        const row: IntegrationCredentialMetadataRecord = {
          id: `cred_${input.connectionId}_${input.kind}`,
          connectionId: input.connectionId,
          kind: input.kind,
          hint: maskFake(input.secret),
          scopes: [...(input.scopes ?? [])],
        }
        credentialRows.set(slot(input.connectionId, input.kind), row)
        return row
      },
      listMetadata: async (_workspaceId, connectionId) =>
        [...credentialRows.values()].filter((row) => row.connectionId === connectionId),
      readSecret: async (
        _workspaceId: string,
        connectionId: string,
        kind: IntegrationCredentialKindValue,
      ) => secrets.get(slot(connectionId, kind)) ?? null,
      delete: async (_workspaceId, connectionId, kind) => {
        secrets.delete(slot(connectionId, kind))
        credentialRows.delete(slot(connectionId, kind))
      },
      deleteAll: async (_workspaceId, connectionId) => {
        for (const key of [...secrets.keys()]) {
          if (key.startsWith(`${connectionId}:`)) secrets.delete(key)
        }
        for (const key of [...credentialRows.keys()]) {
          if (key.startsWith(`${connectionId}:`)) credentialRows.delete(key)
        }
      },
    },
    webhooks: {
      find: async (connectionId, providerEventId) =>
        webhookRows.find(
          (row) => row.connectionId === connectionId && row.providerEventId === providerEventId,
        ) ?? null,
      record: async (workspaceId, input) => {
        const row = {
          id: `whe_${webhookRows.length + 1}`,
          workspaceId,
          connectionId: input.connectionId,
          providerId: input.providerId,
          providerEventId: input.providerEventId,
          eventType: input.eventType ?? null,
          status: "received",
          payload: input.payload,
        }
        webhookRows.push(row)
        return row
      },
      mark: async (_workspaceId, id, status, patch) => {
        const row = webhookRows.find((candidate) => candidate.id === id)
        if (row) {
          row.status = status
          if (patch?.eventType !== undefined) row.eventType = patch.eventType
          if (patch?.error !== undefined) row.error = patch.error
        }
      },
      list: async (_workspaceId, connectionId) =>
        webhookRows.filter((row) => row.connectionId === connectionId),
    },
    audit: async (input) => {
      audits.push(input)
    },
    events: bus,
    now: () => new Date("2026-09-19T12:00:00.000Z"),
  })

  return { service, events, audits, secrets, webhookRows, handled, connections }
}

function oauthProvider(): IntegrationProviderPort {
  return {
    id: "oauth-only",
    displayName: "OAuth Only",
    category: "email",
    capabilities: ["email.send"],
    authKind: "oauth2",
    configSchema: z.object({}),
    connect: async () => ({}),
    disconnect: async () => undefined,
    healthCheck: async () => ({ status: "connected" }),
  }
}

function failingProvider(): IntegrationProviderPort {
  return {
    ...createGenericWebhookIntegrationProvider(),
    id: "flaky",
    displayName: "Flaky",
    connect: async ({ secret }) => {
      throw new Error(`upstream rejected key ${String(secret)}`)
    },
    healthCheck: async () => {
      throw new Error(`health probe failed for ${API_KEY}`)
    },
  }
}

function connectInput(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "generic-webhook",
    displayName: "Ops automation",
    config: { allowedEventTypes: [] },
    apiKey: API_KEY,
    webhookSecret: WEBHOOK_SECRET,
    ...overrides,
  }
}

function signedDelivery(body: string) {
  return {
    "x-yourcrm-signature": signIntegrationWebhookBody({
      secret: WEBHOOK_SECRET,
      rawBody: body,
      algorithm: "sha256",
      prefix: "sha256=",
    }),
  }
}

describe("integrations/service", () => {
  let harness: Harness
  let ctx: ReturnType<typeof makeServiceContext>

  beforeEach(() => {
    allConnections.clear()
    harness = makeHarness()
    ctx = makeServiceContext({ session: makeSession({ role: "admin" }) })
  })

  afterEach(() => {
    harness.events.release()
  })

  test("connect installs a provider, seals the secret and emits integration.connected", async () => {
    const detail = await harness.service.connect(ctx, connectInput())
    expect(detail.connection.status).toBe("connected")
    expect(detail.connection.providerId).toBe("generic-webhook")
    expect(detail.webhookPath).toBe(`/api/v1/integrations/${detail.connection.id}/webhook`)
    harness.events.expectEmitted(IntegrationEvents.Connected, {
      workspaceId: ctx.workspaceId,
      entityId: detail.connection.id,
    })
    expect(harness.audits.map((a) => a.action)).toContain("connect")
    expect(harness.secrets.get(`${detail.connection.id}:api_key`)).toBe(API_KEY)
    expect(harness.secrets.get(`${detail.connection.id}:webhook_secret`)).toBe(WEBHOOK_SECRET)
  })

  test("no response carries a credential — only a masked hint", async () => {
    const detail = await harness.service.connect(ctx, connectInput())
    const serialised = JSON.stringify(detail)
    expect(serialised).not.toContain(API_KEY)
    expect(serialised).not.toContain(WEBHOOK_SECRET)
    expect(detail.credentials.map((c) => c.hint)).toContain("sk-…4f2a")

    const fetched = await harness.service.getConnection(ctx, detail.connection.id)
    expect(JSON.stringify(fetched)).not.toContain(API_KEY)

    const listed = await harness.service.listConnections(ctx, {})
    expect(JSON.stringify(listed)).not.toContain(API_KEY)
  })

  test("audit rows never carry a credential", async () => {
    await harness.service.connect(ctx, connectInput())
    expect(JSON.stringify(harness.audits)).not.toContain(API_KEY)
    expect(JSON.stringify(harness.audits)).not.toContain(WEBHOOK_SECRET)
  })

  test("a provider that rejects the key leaves an error connection, redacted", async () => {
    const failing = makeHarness({ providers: [failingProvider()] })
    const attempt = failing.service.connect(ctx, connectInput({ providerId: "flaky" }))
    await expect(attempt).rejects.toThrow(IntegrationConnectFailedError)
    const stored = failing.connections.list(ctx.workspaceId)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.status).toBe("error")
    expect(String(stored[0]?.lastError)).toContain("[redacted]")
    expect(String(stored[0]?.lastError)).not.toContain(API_KEY)
    failing.events.expectEmitted(IntegrationEvents.Errored)
    failing.events.release()
  })

  test("unknown providers and OAuth providers are refused", async () => {
    await expect(
      harness.service.connect(ctx, connectInput({ providerId: "nope" })),
    ).rejects.toThrow(IntegrationProviderNotRegisteredError)
    const oauth = makeHarness({ providers: [oauthProvider()] })
    await expect(
      oauth.service.connect(ctx, connectInput({ providerId: "oauth-only" })),
    ).rejects.toThrow(IntegrationOAuthNotSupportedError)
    oauth.events.release()
  })

  test("invalid provider config is rejected by the provider's own schema", async () => {
    await expect(
      harness.service.connect(ctx, connectInput({ config: { allowedEventTypes: [123] } })),
    ).rejects.toThrow()
  })

  test("disconnect revokes every credential and emits integration.disconnected", async () => {
    const detail = await harness.service.connect(ctx, connectInput())
    harness.events.clear()
    const after = await harness.service.disconnect(ctx, detail.connection.id)
    expect(after.status).toBe("disconnected")
    expect(harness.secrets.size).toBe(0)
    harness.events.expectEmitted(IntegrationEvents.Disconnected, { entityId: after.id })
    expect(harness.audits.map((a) => a.action)).toContain("disconnect")
  })

  test("health checks record status, and a failing probe is redacted", async () => {
    const detail = await harness.service.connect(ctx, connectInput())
    const healthy = await harness.service.checkHealth(ctx, detail.connection.id)
    expect(healthy.status).toBe("connected")
    expect(healthy.lastHealthStatus).toBe("connected")
    harness.events.expectEmitted(IntegrationEvents.HealthChecked)

    const failing = makeHarness({ providers: [failingProvider()] })
    const row = failing.connections.insert({
      ...makeBaseRecord({ workspaceId: ctx.workspaceId }),
      providerId: "flaky",
      displayName: "Flaky",
      status: "connected",
    })
    allConnections.set(row.id, row)
    failing.secrets.set(`${row.id}:api_key`, API_KEY)
    const unhealthy = await failing.service.checkHealth(ctx, row.id)
    expect(unhealthy.status).toBe("error")
    expect(String(unhealthy.lastError)).toContain("[redacted]")
    failing.events.expectEmitted(IntegrationEvents.Errored)
    failing.events.release()
  })

  test("rotating credentials re-verifies the key and emits integration.reconnected", async () => {
    const detail = await harness.service.connect(ctx, connectInput())
    harness.events.clear()
    const rotated = await harness.service.rotateCredentials(ctx, detail.connection.id, {
      apiKey: "sk-live-rotated-9999999999abcd",
    })
    expect(harness.secrets.get(`${detail.connection.id}:api_key`)).toBe(
      "sk-live-rotated-9999999999abcd",
    )
    expect(rotated.connection.status).toBe("connected")
    harness.events.expectEmitted(IntegrationEvents.Reconnected)
    const rotateAudit = harness.audits.find((a) => a.action === "rotate_credentials")
    expect(JSON.stringify(rotateAudit)).toContain("api_key")
    expect(JSON.stringify(rotateAudit)).not.toContain("sk-live-rotated")
  })

  test("listProviders returns the registered catalogue with install counts", async () => {
    const before = await harness.service.listProviders(ctx)
    expect(before.map((p) => p.id)).toEqual(["generic-webhook"])
    expect(before[0]?.connectionCount).toBe(0)
    expect(before[0]?.supportsWebhooks).toBe(true)
    await harness.service.connect(ctx, connectInput())
    const after = await harness.service.listProviders(ctx)
    expect(after[0]?.connectionCount).toBe(1)
  })

  test("a missing connection is a NOT_FOUND, not a crash", async () => {
    await expect(harness.service.getConnection(ctx, "missing")).rejects.toThrow(
      IntegrationConnectionNotFoundError,
    )
  })

  test("non-admins are denied every integration operation", async () => {
    for (const role of ["viewer", "member"] as const) {
      const denied = makeServiceContext({ session: makeSession({ role }) })
      await expectDenied(() => harness.service.listProviders(denied))
      await expectDenied(() => harness.service.listConnections(denied, {}))
      await expectDenied(() => harness.service.getConnection(denied, "any"))
      await expectDenied(() => harness.service.connect(denied, connectInput()))
      await expectDenied(() =>
        harness.service.updateConnection(denied, "any", { displayName: "x" }),
      )
      await expectDenied(() =>
        harness.service.rotateCredentials(denied, "any", { apiKey: API_KEY }),
      )
      await expectDenied(() => harness.service.checkHealth(denied, "any"))
      await expectDenied(() => harness.service.disconnect(denied, "any"))
    }
  })

  test("redactIntegrationSecrets strips every occurrence", () => {
    expect(redactIntegrationSecrets(`a ${API_KEY} b ${API_KEY}`, API_KEY)).toBe(
      "a [redacted] b [redacted]",
    )
    expect(redactIntegrationSecrets("nothing to hide", null, undefined, "short")).toBe(
      "nothing to hide",
    )
  })
})

describe("integrations/webhook ingestion", () => {
  let harness: Harness
  let ctx: ReturnType<typeof makeServiceContext>
  let connectionId: string

  beforeEach(async () => {
    allConnections.clear()
    harness = makeHarness()
    ctx = makeServiceContext({ session: makeSession({ role: "admin" }) })
    const detail = await harness.service.connect(ctx, connectInput())
    connectionId = detail.connection.id
    harness.events.clear()
  })

  afterEach(() => {
    harness.events.release()
  })

  test("a correctly signed delivery is verified, recorded and dispatched", async () => {
    const rawBody = JSON.stringify({ id: "evt_1", type: "lead.created" })
    const result = await harness.service.ingestWebhook({
      connectionId,
      headers: signedDelivery(rawBody),
      rawBody,
    })
    expect(result.status).toBe("processed")
    expect(result.providerEventId).toBe("evt_1")
    expect(harness.handled).toHaveLength(1)
    expect(harness.webhookRows[0]?.status).toBe("processed")
    harness.events.expectEmitted(IntegrationEvents.WebhookReceived)
  })

  test("a bad signature is rejected with UNAUTHORIZED and nothing is recorded", async () => {
    const rawBody = JSON.stringify({ id: "evt_2", type: "lead.created" })
    await expect(
      harness.service.ingestWebhook({
        connectionId,
        headers: { "x-yourcrm-signature": "sha256=deadbeefdeadbeef" },
        rawBody,
      }),
    ).rejects.toThrow(IntegrationSignatureError)
    expect(harness.webhookRows).toHaveLength(0)
    expect(harness.handled).toHaveLength(0)
    expect(harness.events.count(IntegrationEvents.WebhookReceived)).toBe(0)
  })

  test("a signature over a different body is rejected", async () => {
    const rawBody = JSON.stringify({ id: "evt_3", type: "lead.created" })
    await expect(
      harness.service.ingestWebhook({
        connectionId,
        headers: signedDelivery(JSON.stringify({ id: "evt_3", type: "tampered" })),
        rawBody,
      }),
    ).rejects.toThrow(IntegrationSignatureError)
  })

  test("an unknown connection id looks exactly like a bad signature", async () => {
    const rawBody = JSON.stringify({ id: "evt_4" })
    await expect(
      harness.service.ingestWebhook({
        connectionId: "does-not-exist",
        headers: signedDelivery(rawBody),
        rawBody,
      }),
    ).rejects.toThrow(IntegrationSignatureError)
  })

  test("a connection with no stored webhook secret cannot be called", async () => {
    harness.secrets.delete(`${connectionId}:webhook_secret`)
    const rawBody = JSON.stringify({ id: "evt_5" })
    await expect(
      harness.service.ingestWebhook({
        connectionId,
        headers: signedDelivery(rawBody),
        rawBody,
      }),
    ).rejects.toThrow(IntegrationSignatureError)
  })

  test("redelivery of the same provider event id is idempotent", async () => {
    const rawBody = JSON.stringify({ id: "evt_6", type: "lead.created" })
    const headers = signedDelivery(rawBody)
    const first = await harness.service.ingestWebhook({ connectionId, headers, rawBody })
    const second = await harness.service.ingestWebhook({ connectionId, headers, rawBody })
    expect(first.status).toBe("processed")
    expect(second.status).toBe("duplicate")
    expect(harness.handled).toHaveLength(1)
    expect(harness.webhookRows).toHaveLength(1)
  })

  test("a body with no event id falls back to a deterministic fingerprint", async () => {
    const rawBody = JSON.stringify({ type: "lead.created" })
    const headers = signedDelivery(rawBody)
    const first = await harness.service.ingestWebhook({ connectionId, headers, rawBody })
    expect(first.providerEventId.startsWith("sha256:")).toBe(true)
    const second = await harness.service.ingestWebhook({ connectionId, headers, rawBody })
    expect(second.status).toBe("duplicate")
  })

  test("the provider config filters event types into 'ignored'", async () => {
    const filtered = makeHarness()
    const detail = await filtered.service.connect(
      ctx,
      connectInput({ config: { allowedEventTypes: ["lead.created"] } }),
    )
    const rawBody = JSON.stringify({ id: "evt_7", type: "spam.event" })
    const result = await filtered.service.ingestWebhook({
      connectionId: detail.connection.id,
      headers: signedDelivery(rawBody),
      rawBody,
    })
    expect(result.status).toBe("ignored")
    expect(filtered.handled).toHaveLength(0)
    filtered.events.release()
  })

  test("a failing handler marks the delivery failed and a retry re-dispatches", async () => {
    const failing = makeHarness({ handlerThrows: true })
    const detail = await failing.service.connect(ctx, connectInput())
    const rawBody = JSON.stringify({ id: "evt_8", type: "lead.created" })
    const headers = signedDelivery(rawBody)
    await expect(
      failing.service.ingestWebhook({ connectionId: detail.connection.id, headers, rawBody }),
    ).rejects.toThrow(IntegrationWebhookHandlerError)
    expect(failing.webhookRows[0]?.status).toBe("failed")
    expect(String(failing.webhookRows[0]?.error)).toContain("[redacted]")
    expect(failing.audits.map((a) => a.action)).toContain("webhook_failed")
    // The provider retries: a previously failed delivery is dispatched again.
    await expect(
      failing.service.ingestWebhook({ connectionId: detail.connection.id, headers, rawBody }),
    ).rejects.toThrow(IntegrationWebhookHandlerError)
    expect(failing.webhookRows).toHaveLength(1)
    failing.events.release()
  })
})
