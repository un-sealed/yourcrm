import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import {
  createGenericWebhookIntegrationProvider,
  createIntegrationProviderCatalog,
  createIntegrationsService,
  signIntegrationWebhookBody,
  type IntegrationConnectionRecord,
  type IntegrationCredentialMetadataRecord,
  type IntegrationsService,
  type IntegrationWebhookEventRecord,
} from "@yourcrm/crm/src/integrations"
import { createApiClient, createStore, makeBaseRecord, makeSession } from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes } from "./integrations"

const API_KEY = "sk-live-0123456789abcdef4f2a"
const WEBHOOK_SECRET = "whsec_0123456789abcdef0123456789"

type StoredConnection = BaseRecord & Record<string, unknown>

/**
 * Hermetic API test: the route factory takes a service, so tests inject the
 * real domain service over in-memory stores. Sessions ride a tiny test-only
 * middleware (role-accurate without touching the foundation auth hook).
 */
function makeFakeService(): IntegrationsService {
  const connections = createStore<StoredConnection>()
  const byId = new Map<string, StoredConnection>()
  const secrets = new Map<string, string>()
  const credentials = new Map<string, IntegrationCredentialMetadataRecord>()
  const webhookRows: IntegrationWebhookEventRecord[] = []
  const slot = (connectionId: string, kind: string) => `${connectionId}:${kind}`

  return createIntegrationsService({
    providers: createIntegrationProviderCatalog([createGenericWebhookIntegrationProvider()]),
    store: {
      list: async (workspaceId, query) => {
        const rows = connections.list(workspaceId) as unknown as IntegrationConnectionRecord[]
        return { data: rows, pagination: { nextCursor: null, limit: query.limit ?? 25 } }
      },
      findById: async (workspaceId, id) =>
        connections.get(id, workspaceId) as IntegrationConnectionRecord | null,
      findForWebhook: async (id) =>
        (byId.get(id) as IntegrationConnectionRecord | undefined) ?? null,
      create: async (workspaceId, input, actorId) => {
        const row = connections.insert({
          ...makeBaseRecord({ workspaceId, createdBy: actorId, updatedBy: actorId }),
          ...input,
        })
        byId.set(row.id, row)
        return row as unknown as IntegrationConnectionRecord
      },
      update: async (workspaceId, id, patch) => {
        const row = connections.update(id, workspaceId, patch)
        if (row) byId.set(row.id, row)
        return (row as IntegrationConnectionRecord | null) ?? null
      },
      softDelete: async (workspaceId, id) => {
        connections.remove(id, workspaceId)
      },
    },
    credentials: {
      put: async (_workspaceId, input) => {
        secrets.set(slot(input.connectionId, input.kind), input.secret)
        const row: IntegrationCredentialMetadataRecord = {
          id: `cred_${input.connectionId}_${input.kind}`,
          connectionId: input.connectionId,
          kind: input.kind,
          hint: `${input.secret.slice(0, 3)}…${input.secret.slice(-4)}`,
          scopes: [...(input.scopes ?? [])],
        }
        credentials.set(slot(input.connectionId, input.kind), row)
        return row
      },
      listMetadata: async (_workspaceId, connectionId) =>
        [...credentials.values()].filter((row) => row.connectionId === connectionId),
      readSecret: async (_workspaceId, connectionId, kind) =>
        secrets.get(slot(connectionId, kind)) ?? null,
      delete: async (_workspaceId, connectionId, kind) => {
        secrets.delete(slot(connectionId, kind))
        credentials.delete(slot(connectionId, kind))
      },
      deleteAll: async (_workspaceId, connectionId) => {
        for (const key of [...secrets.keys()]) {
          if (key.startsWith(`${connectionId}:`)) secrets.delete(key)
        }
        for (const key of [...credentials.keys()]) {
          if (key.startsWith(`${connectionId}:`)) credentials.delete(key)
        }
      },
    },
    webhooks: {
      find: async (connectionId, providerEventId) =>
        webhookRows.find(
          (row) => row.connectionId === connectionId && row.providerEventId === providerEventId,
        ) ?? null,
      record: async (workspaceId, input) => {
        const row: IntegrationWebhookEventRecord = {
          id: `whe_${webhookRows.length + 1}`,
          workspaceId,
          connectionId: input.connectionId,
          providerId: input.providerId,
          providerEventId: input.providerEventId,
          eventType: input.eventType ?? null,
          status: "received",
        }
        webhookRows.push(row)
        return row
      },
      mark: async (_workspaceId, id, status) => {
        const row = webhookRows.find((candidate) => candidate.id === id)
        if (row) row.status = status
      },
      list: async (_workspaceId, connectionId) =>
        webhookRows.filter((row) => row.connectionId === connectionId),
    },
    audit: async () => undefined,
  })
}

function makeTestApp(session: { current: Session | null }, service: IntegrationsService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/integrations", createRoutes({ service }))
  return app
}

function connectBody(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "generic-webhook",
    displayName: "Ops automation",
    config: { allowedEventTypes: [] },
    apiKey: API_KEY,
    webhookSecret: WEBHOOK_SECRET,
    ...overrides,
  }
}

function signed(rawBody: string) {
  return {
    "content-type": "application/json",
    "x-yourcrm-signature": signIntegrationWebhookBody({
      secret: WEBHOOK_SECRET,
      rawBody,
      algorithm: "sha256",
      prefix: "sha256=",
    }),
  }
}

describe("api/integrations", () => {
  let session: { current: Session | null }
  let service: IntegrationsService
  let owner: Session

  beforeEach(() => {
    owner = makeSession({ role: "owner" })
    session = { current: owner }
    service = makeFakeService()
  })

  test("unauthenticated requests get UNAUTHORIZED", async () => {
    session.current = null
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/integrations")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("non-admin members are forbidden, even for reads", async () => {
    for (const role of ["viewer", "member"] as const) {
      session.current = makeSession({ role })
      const api = createApiClient({ app: makeTestApp(session, service), session: session.current })
      for (const path of ["/api/v1/integrations", "/api/v1/integrations/providers"]) {
        const res = await api.get(path)
        expect(res.status).toBe(403)
        res.expectError("FORBIDDEN")
      }
      const denied = await api.post("/api/v1/integrations", connectBody())
      expect(denied.status).toBe(403)
      denied.expectError("FORBIDDEN")
    }
  })

  test("the provider catalogue lists registered providers", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const res = await api.get("/api/v1/integrations/providers")
    const { data } = res.expectSuccess()
    expect(Array.isArray(data)).toBe(true)
    expect(JSON.stringify(data)).toContain("generic-webhook")
  })

  test("connect returns 201 and never echoes the credentials", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const res = await api.post("/api/v1/integrations", connectBody())
    expect(res.status).toBe(201)
    const body = JSON.stringify(res.expectSuccess())
    expect(body).not.toContain(API_KEY)
    expect(body).not.toContain(WEBHOOK_SECRET)
    expect(body).toContain("sk-…4f2a")
  })

  test("list, detail and disconnect round-trip without leaking a secret", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const created = await api.post("/api/v1/integrations", connectBody())
    const detailId = (created.expectSuccess().data as { connection: { id: string } }).connection.id

    const list = await api.get("/api/v1/integrations")
    const listed = list.expectSuccess()
    expect(Array.isArray(listed.data)).toBe(true)
    expect(listed.pagination?.limit).toBe(25)
    expect(JSON.stringify(listed)).not.toContain(API_KEY)

    const detail = await api.get(`/api/v1/integrations/${detailId}`)
    expect(JSON.stringify(detail.expectSuccess())).not.toContain(API_KEY)

    const health = await api.post(`/api/v1/integrations/${detailId}/health`)
    expect((health.expectSuccess().data as { status: string }).status).toBe("connected")

    const removed = await api.delete(`/api/v1/integrations/${detailId}`)
    expect((removed.expectSuccess().data as { status: string }).status).toBe("disconnected")
  })

  test("an unknown connection is a 404 and an unknown provider a 404", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const missing = await api.get("/api/v1/integrations/nope")
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")

    const unknownProvider = await api.post(
      "/api/v1/integrations",
      connectBody({ providerId: "not-registered" }),
    )
    expect(unknownProvider.status).toBe(404)
  })

  test("invalid bodies are rejected with VALIDATION_ERROR", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const short = await api.post("/api/v1/integrations", connectBody({ apiKey: "tiny" }))
    expect(short.status).toBe(400)
    short.expectError("VALIDATION_ERROR")

    const emptyPatch = await api.patch("/api/v1/integrations/any", {})
    expect(emptyPatch.status).toBe(400)
    emptyPatch.expectError("VALIDATION_ERROR")
  })

  test("a correctly signed webhook is accepted without a session", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const created = await api.post("/api/v1/integrations", connectBody())
    const id = (created.expectSuccess().data as { connection: { id: string } }).connection.id

    const rawBody = JSON.stringify({ id: "evt_1", type: "lead.created" })
    const anon = createApiClient({ app: makeTestApp(session, service), session: null })
    const res = await anon.request(`/api/v1/integrations/${id}/webhook`, {
      method: "POST",
      body: rawBody,
      headers: signed(rawBody),
    })
    expect(res.status).toBe(202)
    expect((res.expectSuccess().data as { status: string }).status).toBe("processed")

    // Replay of the same provider event id is idempotent.
    const replay = await anon.request(`/api/v1/integrations/${id}/webhook`, {
      method: "POST",
      body: rawBody,
      headers: signed(rawBody),
    })
    expect(replay.status).toBe(200)
    expect((replay.expectSuccess().data as { status: string }).status).toBe("duplicate")
  })

  test("a bad webhook signature is rejected with 401", async () => {
    const api = createApiClient({ app: makeTestApp(session, service), session: owner })
    const created = await api.post("/api/v1/integrations", connectBody())
    const id = (created.expectSuccess().data as { connection: { id: string } }).connection.id
    const rawBody = JSON.stringify({ id: "evt_2", type: "lead.created" })
    const anon = createApiClient({ app: makeTestApp(session, service), session: null })

    for (const headers of [
      { "content-type": "application/json", "x-yourcrm-signature": "sha256=deadbeef" },
      { "content-type": "application/json" },
      signed(JSON.stringify({ id: "evt_2", type: "different-body" })),
    ]) {
      const res = await anon.request(`/api/v1/integrations/${id}/webhook`, {
        method: "POST",
        body: rawBody,
        headers,
      })
      expect(res.status).toBe(401)
      res.expectError("UNAUTHORIZED")
    }
  })

  test("an unknown connection id on the webhook endpoint also gets 401", async () => {
    const rawBody = JSON.stringify({ id: "evt_3" })
    const anon = createApiClient({ app: makeTestApp(session, service), session: null })
    const res = await anon.request("/api/v1/integrations/unknown-id/webhook", {
      method: "POST",
      body: rawBody,
      headers: signed(rawBody),
    })
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })
})
