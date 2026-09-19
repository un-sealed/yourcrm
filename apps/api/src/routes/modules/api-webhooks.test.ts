import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import {
  createApiWebhooksService,
  type ApiWebhooksService,
  type PublicApiKeyRecord,
  type ResolvedPublicApiKey,
  type WebhookDeliveryRecord,
  type WebhookSubscriptionRecord,
} from "@yourcrm/crm/src/api-webhooks"
import { makeSession } from "@yourcrm/testing"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { publicApiKeyAuth, sessionFromPublicApiKey } from "../../lib/api-key-auth"
import { createRoutes } from "./api-webhooks"

/**
 * Hermetic API test: the route factory takes a service, so the real domain
 * service runs over in-memory stores. Sessions ride a tiny test-only
 * middleware, and the API-key middleware is mounted exactly the way the
 * integrator is asked to mount it — so the last block below is a genuine
 * end-to-end proof that a key's role governs what the key can do.
 */

const WORKSPACE = "ws_api"
const TARGET = "https://hooks.example.com/yourcrm"

function makeFakeService() {
  let sequence = 0
  const nextId = (prefix: string) => `${prefix}_${(sequence += 1)}`
  const subscriptions = new Map<string, WebhookSubscriptionRecord>()
  const secrets = new Map<string, string>()
  const deliveries = new Map<string, WebhookDeliveryRecord>()
  const keys = new Map<string, PublicApiKeyRecord & { rawKey: string; revoked: boolean }>()
  /** Strip the stored key material: a key record never carries it. */
  const publicKeyOf = (
    row: PublicApiKeyRecord & { rawKey: string; revoked: boolean },
  ): PublicApiKeyRecord => {
    const copy: Record<string, unknown> = { ...row }
    delete copy.rawKey
    delete copy.revoked
    return copy as PublicApiKeyRecord
  }

  const service = createApiWebhooksService({
    audit: async () => undefined,
    resolveDns: async () => ["93.184.216.34"],
    transport: async () => ({ statusCode: 200, bodySnippet: "ok" }),
    queue: { enqueueWebhookDelivery: async () => undefined },
    store: {
      list: async (workspaceId, query) => ({
        data: [...subscriptions.values()].filter((row) => row.workspaceId === workspaceId),
        pagination: { nextCursor: null, limit: query.limit ?? 25 },
      }),
      findById: async (workspaceId, id) => {
        const row = subscriptions.get(id)
        return row && row.workspaceId === workspaceId ? { ...row } : null
      },
      findActiveForEvent: async (workspaceId, eventName) =>
        [...subscriptions.values()].filter(
          (row) =>
            row.workspaceId === workspaceId && row.active && row.eventNames.includes(eventName),
        ),
      create: async (workspaceId, input) => {
        const id = nextId("sub")
        const row: WebhookSubscriptionRecord = {
          id,
          workspaceId,
          name: input.name,
          description: input.description ?? null,
          targetUrl: input.targetUrl,
          eventNames: input.eventNames,
          active: input.active,
          secretHint: `whsec_…${input.secret.slice(-4)}`,
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
      softDelete: async (_workspaceId, id) => {
        subscriptions.delete(id)
      },
      recordOutcome: async () => ({ consecutiveFailures: 0 }),
    },
    deliveries: {
      list: async (workspaceId, query) => ({
        data: [...deliveries.values()].filter((row) => row.workspaceId === workspaceId),
        pagination: { nextCursor: null, limit: query.limit ?? 25 },
      }),
      findById: async (workspaceId, id) => {
        const row = deliveries.get(id)
        return row && row.workspaceId === workspaceId ? { ...row } : null
      },
      findForDelivery: async (id) => deliveries.get(id) ?? null,
      createIfAbsent: async (workspaceId, input) => {
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
      claim: async () => null,
      recordAttempt: async () => null,
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
          createdBy: actorId ?? null,
          rawKey: input.rawKey,
          revoked: false,
        }
        keys.set(id, row)
        return publicKeyOf(row)
      },
      findByRawKey: async (rawKey) => {
        const row = [...keys.values()].find((k) => k.rawKey === rawKey && !k.revoked)
        if (!row) return null
        return {
          id: row.id,
          workspaceId: row.workspaceId,
          name: row.name,
          role: row.role,
          createdBy: (row.createdBy as string | null) ?? null,
          expiresAt: null,
        }
      },
      touchLastUsed: async () => undefined,
      revoke: async (workspaceId, id) => {
        const row = keys.get(id)
        if (!row || row.workspaceId !== workspaceId) return null
        const next = { ...row, revoked: true }
        keys.set(id, next)
        return publicKeyOf(next)
      },
    },
  })

  return { service, keys }
}

function makeTestApp(session: { current: Session | null }, service: ApiWebhooksService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("requestId", "req_test")
    c.set("session", session.current)
    await next()
  })
  app.route("/api-webhooks", createRoutes({ service }))
  return app
}

type Envelope<T> = { data: T }

describe("api/api-webhooks", () => {
  let harness: ReturnType<typeof makeFakeService>
  let session: { current: Session | null }
  let app: ReturnType<typeof makeTestApp>

  beforeEach(() => {
    harness = makeFakeService()
    session = { current: makeSession({ role: "owner", workspaceId: WORKSPACE }) }
    app = makeTestApp(session, harness.service)
  })

  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })

  const createSubscription = () =>
    post("/api-webhooks/subscriptions", {
      name: "Ops relay",
      targetUrl: TARGET,
      eventNames: ["person.created"],
    })

  test("every route requires a session", async () => {
    session.current = null
    for (const path of [
      "/api-webhooks/events",
      "/api-webhooks/subscriptions",
      "/api-webhooks/deliveries",
      "/api-webhooks/keys",
    ]) {
      expect((await app.request(path)).status).toBe(401)
    }
    expect((await createSubscription()).status).toBe(401)
  })

  test("the event catalogue comes from @yourcrm/events", async () => {
    const res = await app.request("/api-webhooks/events")
    expect(res.status).toBe(200)
    const body = (await res.json()) as Envelope<{ name: string; domain: string }[]>
    expect(body.data.some((e) => e.name === "person.created" && e.domain === "person")).toBe(true)
    expect(body.data.some((e) => e.name === "webhook.delivery_failed")).toBe(false)
  })

  test("creating a subscription returns the signing secret exactly once", async () => {
    const res = await createSubscription()
    expect(res.status).toBe(201)
    const created = (await res.json()) as Envelope<{
      subscription: { id: string; secretHint: string }
      signingSecret: string
    }>
    const secret = created.data.signingSecret
    expect(secret.startsWith("whsec_")).toBe(true)

    // Nothing else ever shows it again.
    const detail = await app.request(`/api-webhooks/subscriptions/${created.data.subscription.id}`)
    const list = await app.request("/api-webhooks/subscriptions")
    expect(await detail.text()).not.toContain(secret)
    expect(await list.text()).not.toContain(secret)
    // There is no endpoint that reveals it, either.
    expect(
      (await app.request(`/api-webhooks/subscriptions/${created.data.subscription.id}/secret`))
        .status,
    ).toBe(404)
  })

  test("rotation issues a new secret and never echoes the old", async () => {
    const created = (await (await createSubscription()).json()) as Envelope<{
      subscription: { id: string }
      signingSecret: string
    }>
    const res = await post(`/api-webhooks/subscriptions/${created.data.subscription.id}/secret`, {})
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain(created.data.signingSecret)
    expect(text).toContain("whsec_")
  })

  test("SSRF: a blocked target is a 400 naming the rule, not a 500", async () => {
    for (const targetUrl of [
      "http://localhost",
      "http://169.254.169.254/",
      "http://10.0.0.1",
      "https://localhost",
      "https://169.254.169.254/",
      "https://10.0.0.1",
      "https://[::1]/hook",
      "https://metadata.google.internal/",
    ]) {
      const res = await post("/api-webhooks/subscriptions", {
        name: `Bad ${targetUrl}`,
        targetUrl,
        eventNames: ["person.created"],
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe("VALIDATION_ERROR")
    }
  })

  test("an unknown event name is a 400", async () => {
    const res = await post("/api-webhooks/subscriptions", {
      name: "Bad events",
      targetUrl: TARGET,
      eventNames: ["person.exploded"],
    })
    expect(res.status).toBe(400)
  })

  test("issuing a key returns it once; listing never does", async () => {
    const res = await post("/api-webhooks/keys", { name: "CI", role: "member" })
    expect(res.status).toBe(201)
    const created = (await res.json()) as Envelope<{ key: string; apiKey: { id: string } }>
    expect(created.data.key.startsWith("ycrm_sk_")).toBe(true)

    const list = await app.request("/api-webhooks/keys")
    expect(await list.text()).not.toContain(created.data.key)

    const revoked = await app.request(`/api-webhooks/keys/${created.data.apiKey.id}`, {
      method: "DELETE",
    })
    expect(revoked.status).toBe(200)
    expect(await revoked.text()).not.toContain(created.data.key)
  })

  test("a viewer session is denied every surface", async () => {
    session.current = makeSession({ role: "viewer", workspaceId: WORKSPACE })
    expect((await app.request("/api-webhooks/subscriptions")).status).toBe(403)
    expect((await app.request("/api-webhooks/deliveries")).status).toBe(403)
    expect((await app.request("/api-webhooks/keys")).status).toBe(403)
    expect((await createSubscription()).status).toBe(403)
  })

  test("an unknown id is a 404 in the shared error envelope", async () => {
    const res = await app.request("/api-webhooks/subscriptions/sub_missing")
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string; requestId?: string } }
    expect(body.error.code).toBe("NOT_FOUND")
    expect(body.error.requestId).toBe("req_test")
  })
})

/**
 * The property that matters most for API keys: a key is a session, and a
 * session's role is enforced by the SAME `requirePermission()` the cookie
 * path uses. Nothing here special-cases keys.
 */
describe("api/api-webhooks/api-key-auth", () => {
  test("AN API KEY CANNOT EXCEED ITS ROLE: a viewer key is denied a write", async () => {
    const harness = makeFakeService()
    const session = {
      current: makeSession({ role: "owner", workspaceId: WORKSPACE }) as Session | null,
    }

    // An owner issues two keys: one at owner level, one at viewer level.
    const ownerKey = await harness.service.createApiKey(
      { workspaceId: WORKSPACE, actorId: "u_1", role: "owner" },
      { name: "Deploy", role: "owner" },
    )
    const viewerKey = await harness.service.createApiKey(
      { workspaceId: WORKSPACE, actorId: "u_1", role: "owner" },
      { name: "Readonly", role: "viewer" },
    )

    // Mounted exactly as the integrator is asked to mount it: after the
    // session middleware, filling in only when nothing else did.
    const app = new Hono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("requestId", "req_key")
      c.set("session", session.current)
      await next()
    })
    app.use("*", publicApiKeyAuth({ resolve: (raw) => harness.service.resolveApiKey(raw) }))
    app.route("/api-webhooks", createRoutes({ service: harness.service }))

    session.current = null
    const write = (key: string) =>
      app.request("/api-webhooks/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          name: `Relay ${key.slice(-4)}`,
          targetUrl: TARGET,
          eventNames: ["person.created"],
        }),
      })

    // The owner key writes.
    expect((await write(ownerKey.key)).status).toBe(201)
    // The viewer key is refused — by `requirePermission`, not by a
    // key-specific branch.
    const denied = await write(viewerKey.key)
    expect(denied.status).toBe(403)
    const body = (await denied.json()) as { error: { code: string } }
    expect(body.error.code).toBe("FORBIDDEN")
    // And it cannot read the admin surfaces either.
    const read = await app.request("/api-webhooks/keys", {
      headers: { authorization: `Bearer ${viewerKey.key}` },
    })
    expect(read.status).toBe(403)
  })

  test("no key, a garbage key and a revoked key are all 401", async () => {
    const harness = makeFakeService()
    const app = new Hono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("requestId", "req_key")
      c.set("session", null)
      await next()
    })
    app.use("*", publicApiKeyAuth({ resolve: (raw) => harness.service.resolveApiKey(raw) }))
    app.route("/api-webhooks", createRoutes({ service: harness.service }))

    const issued = await harness.service.createApiKey(
      { workspaceId: WORKSPACE, actorId: "u_1", role: "owner" },
      { name: "Temp", role: "admin" },
    )
    const get = (headers: Record<string, string> = {}) =>
      app.request("/api-webhooks/subscriptions", { headers })

    expect((await get()).status).toBe(401)
    expect((await get({ authorization: "Bearer not-a-key" })).status).toBe(401)
    expect((await get({ authorization: `Bearer ${issued.key}` })).status).toBe(200)

    await harness.service.revokeApiKey(
      { workspaceId: WORKSPACE, actorId: "u_1", role: "owner" },
      issued.apiKey.id,
    )
    expect((await get({ authorization: `Bearer ${issued.key}` })).status).toBe(401)
  })

  test("a key session never overwrites a cookie session", async () => {
    const harness = makeFakeService()
    const viewerKey = await harness.service.createApiKey(
      { workspaceId: WORKSPACE, actorId: "u_1", role: "owner" },
      { name: "Readonly", role: "viewer" },
    )
    const app = new Hono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("requestId", "req_key")
      c.set("session", makeSession({ role: "owner", workspaceId: WORKSPACE }))
      await next()
    })
    app.use("*", publicApiKeyAuth({ resolve: (raw) => harness.service.resolveApiKey(raw) }))
    app.route("/api-webhooks", createRoutes({ service: harness.service }))

    // Sending both must not downgrade (or upgrade) the established session.
    const res = await app.request("/api-webhooks/subscriptions", {
      headers: { authorization: `Bearer ${viewerKey.key}` },
    })
    expect(res.status).toBe(200)
  })

  test("the session a key produces is the ordinary Session shape", () => {
    const resolved: ResolvedPublicApiKey = {
      id: "key_1",
      workspaceId: WORKSPACE,
      name: "CI",
      role: "member",
      createdBy: "user_7",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    }
    const built = sessionFromPublicApiKey(resolved)
    expect(built.workspaceId).toBe(WORKSPACE)
    expect(built.memberships).toEqual([{ workspaceId: WORKSPACE, role: "member" }])
    // Writes are attributed to the issuing user (a uuid, as audit requires)
    // and the display name says plainly that a key acted.
    expect(built.user.id).toBe("user_7")
    expect(built.user.name).toBe("API key: CI")
    expect(built.expiresAt).toBe("2030-01-01T00:00:00.000Z")

    // An unrecognised stored role fails closed, to viewer.
    expect(sessionFromPublicApiKey({ ...resolved, role: "superuser" }).memberships[0]?.role).toBe(
      "viewer",
    )
    // No issuer left: fall back to the key's own (uuid) id.
    expect(sessionFromPublicApiKey({ ...resolved, createdBy: null }).user.id).toBe("key_1")
  })
})
