import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import {
  CONSOLE_CALLING_PROVIDER_ID,
  createCallingProviderCatalog,
  createCallingService,
  createConsoleCallingProvider,
  type CallingConnectionRecord,
  type CallingService,
  type CallListQuery,
  type CallRecord,
  type CallRecordingRecord,
} from "@yourcrm/crm/src/calling"
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
import { createRoutes } from "./calling"

type StoredCall = BaseRecord & Record<string, unknown> & { status: string }

const WS = "ws_calling_api_test"
const API_KEY = "dev-token-0123456789"

function asRecord(row: StoredCall): CallRecord {
  return row as unknown as CallRecord
}

/** Real domain service over a hermetic in-memory store, mirroring the crm-level harness. */
function makeFakeService() {
  const calls = createStore<StoredCall>()
  const recordings: CallRecordingRecord[] = []
  const connections = new Map<string, CallingConnectionRecord>()
  const secrets = new Map<string, string>()

  let serviceRef: CallingService | null = null
  const providers = createCallingProviderCatalog([
    createConsoleCallingProvider({
      onStatusEvent: async (evt) => {
        await serviceRef?.applyProviderStatusEvent({
          workspaceId: evt.workspaceId,
          providerId: evt.providerId,
          providerCallId: evt.providerCallId,
          status: evt.status,
          occurredAt: evt.occurredAt,
        })
      },
    }),
  ])

  const service = createCallingService({
    store: {
      list: async (workspaceId: string, query: CallListQuery) => {
        let rows = calls.list(workspaceId)
        if (query.status) rows = rows.filter((r) => r.status === query.status)
        const limit = query.limit ?? 25
        const data = rows.slice(0, limit)
        return {
          data: data.map(asRecord),
          pagination: { nextCursor: rows.length > limit ? (data.at(-1)?.id ?? null) : null, limit },
        }
      },
      findById: async (workspaceId, id) => {
        const row = calls.get(id, workspaceId)
        return row ? asRecord(row) : null
      },
      findByProviderCallId: async (workspaceId, providerId, providerCallId) => {
        const row = calls
          .list(workspaceId)
          .find((r) => r.providerId === providerId && r.providerCallId === providerCallId)
        return row ? asRecord(row) : null
      },
      create: async (workspaceId, input, actorId) =>
        asRecord(
          calls.insert({
            ...makeBaseRecord({ workspaceId }),
            status: "queued",
            ...input,
            ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
          }),
        ),
      update: async (workspaceId, id, patch) => {
        const row = calls.update(id, workspaceId, patch as Partial<StoredCall>)
        return row ? asRecord(row) : null
      },
      advanceStatus: async (workspaceId, id, next) => {
        const row = calls.update(id, workspaceId, { status: next.status } as Partial<StoredCall>)
        return { record: row ? asRecord(row) : null, applied: true }
      },
      softDelete: async (workspaceId, id) => {
        calls.remove(id, workspaceId)
      },
      restore: async (workspaceId, id) => {
        calls.restore(id, workspaceId)
      },
    },
    recordings: {
      create: async (workspaceId, input, actorId) => {
        const record: CallRecordingRecord = {
          id: `rec_${recordings.length + 1}`,
          callId: input.callId,
          url: input.url,
          durationSeconds: input.durationSeconds ?? null,
          sizeBytes: input.sizeBytes ?? null,
          workspaceId,
          createdBy: actorId ?? null,
        }
        recordings.push(record)
        return record
      },
      listForCall: async (_workspaceId, callId) => recordings.filter((r) => r.callId === callId),
    },
    connections: {
      findById: async (workspaceId, id) => {
        const conn = connections.get(id)
        return conn && conn.workspaceId === workspaceId ? conn : null
      },
      listConnected: async (workspaceId) =>
        [...connections.values()].filter(
          (c) => c.workspaceId === workspaceId && c.status === "connected",
        ),
    },
    credentials: {
      readSecret: async (_workspaceId, connectionId) => secrets.get(connectionId) ?? null,
    },
    providers,
    audit: async () => undefined,
  })
  serviceRef = service

  function connectConsoleProvider(connectionId = "conn_1") {
    connections.set(connectionId, {
      id: connectionId,
      workspaceId: WS,
      providerId: CONSOLE_CALLING_PROVIDER_ID,
      status: "connected",
      config: { callerId: "+14155550100" },
    })
    secrets.set(connectionId, API_KEY)
  }

  return { service, connectConsoleProvider }
}

/** Hermetic API test: the route factory takes a service, injected over an in-memory store. */
function makeTestApp(session: { current: Session | null }, service: CallingService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/calling", createRoutes({ service }))
  return app
}

describe("api/calling", () => {
  let session: { current: Session | null }
  let fake: ReturnType<typeof makeFakeService>
  let ctx: ReturnType<typeof makeServiceContext>

  beforeEach(() => {
    const owner = makeSession({ role: "owner", workspaceId: WS })
    ctx = makeServiceContext({ session: owner })
    session = { current: owner }
    fake = makeFakeService()
  })

  test("unauthenticated requests get UNAUTHORIZED", async () => {
    session.current = null
    const api = createApiClient({ app: makeTestApp(session, fake.service) })
    const res = await api.get("/api/v1/calling")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("POST /log creates a manual call with no provider connected, 201", async () => {
    const api = createApiClient({ app: makeTestApp(session, fake.service) })
    const res = await api.post("/api/v1/calling/log", {
      direction: "outbound",
      fromNumber: "+14155550100",
      toNumber: "+14155550199",
      status: "completed",
      disposition: "interested",
    })
    expect(res.status).toBe(201)
    const data = res.expectSuccess().data as { source: string; status: string }
    expect(data.source).toBe("manual")
    expect(data.status).toBe("completed")
  })

  test("POST /log validates the body (missing required fields -> 400)", async () => {
    const api = createApiClient({ app: makeTestApp(session, fake.service) })
    const res = await api.post("/api/v1/calling/log", { direction: "outbound" })
    expect(res.status).toBe(400)
    res.expectError("VALIDATION_ERROR")
  })

  test("GET / returns the cursor pagination envelope", async () => {
    await fake.service.logCall(ctx, {
      direction: "outbound",
      fromNumber: "+14155550100",
      toNumber: "+14155550199",
    })
    const api = createApiClient({ app: makeTestApp(session, fake.service) })
    const res = await api.get("/api/v1/calling")
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("GET /:id returns the call with recordings; unknown id is NOT_FOUND", async () => {
    const created = await fake.service.logCall(ctx, {
      direction: "outbound",
      fromNumber: "+14155550100",
      toNumber: "+14155550199",
    })
    const api = createApiClient({ app: makeTestApp(session, fake.service) })
    const ok = await api.get(`/api/v1/calling/${created.id}`)
    expect(ok.status).toBe(200)
    const data = ok.expectSuccess().data as { call: { id: string }; recordings: unknown[] }
    expect(data.call.id).toBe(created.id)
    expect(data.recordings).toEqual([])

    const missing = await api.get("/api/v1/calling/does-not-exist")
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")
  })

  test("POST /place: click-to-call requires send_external — viewer is FORBIDDEN, member succeeds", async () => {
    fake.connectConsoleProvider()
    const api = createApiClient({ app: makeTestApp(session, fake.service) })

    session.current = makeSession({ role: "viewer", workspaceId: WS })
    const denied = await api.post("/api/v1/calling/place", { toNumber: "+14155550199" })
    expect(denied.status).toBe(403)
    const err = denied.expectError("FORBIDDEN")
    expect(err.error.message).toContain("send_external")

    session.current = makeSession({ role: "member", workspaceId: WS })
    const allowed = await api.post("/api/v1/calling/place", { toNumber: "+14155550199" })
    expect(allowed.status).toBe(201)
    const data = allowed.expectSuccess().data as { source: string; status: string }
    expect(data.source).toBe("provider")
    expect(data.status).toBe("ringing")
  })

  test("POST /place with no connected provider -> 409 NO_PROVIDER_CONNECTED", async () => {
    const api = createApiClient({ app: makeTestApp(session, fake.service) })
    const res = await api.post("/api/v1/calling/place", { toNumber: "+14155550199" })
    expect(res.status).toBe(409)
    res.expectError("NO_PROVIDER_CONNECTED")
  })

  test("PATCH /:id updates disposition/notes", async () => {
    const created = await fake.service.logCall(ctx, {
      direction: "outbound",
      fromNumber: "+14155550100",
      toNumber: "+14155550199",
    })
    const api = createApiClient({ app: makeTestApp(session, fake.service) })
    const res = await api.patch(`/api/v1/calling/${created.id}`, {
      disposition: "no-answer-callback",
    })
    expect(res.status).toBe(200)
    expect((res.expectSuccess().data as { disposition: string }).disposition).toBe(
      "no-answer-callback",
    )
  })

  test("DELETE /:id and POST /:id/restore round-trip", async () => {
    const created = await fake.service.logCall(ctx, {
      direction: "outbound",
      fromNumber: "+14155550100",
      toNumber: "+14155550199",
    })
    const api = createApiClient({ app: makeTestApp(session, fake.service) })
    const deleted = await api.delete(`/api/v1/calling/${created.id}`)
    expect(deleted.status).toBe(200)
    const gone = await api.get(`/api/v1/calling/${created.id}`)
    expect(gone.status).toBe(404)
    const restored = await api.post(`/api/v1/calling/${created.id}/restore`)
    expect(restored.status).toBe(200)
    const back = await api.get(`/api/v1/calling/${created.id}`)
    expect(back.status).toBe(200)
  })

  test("POST /:id/recordings requires recording consent on the call (409) and succeeds once granted", async () => {
    const noConsent = await fake.service.logCall(ctx, {
      direction: "outbound",
      fromNumber: "+14155550100",
      toNumber: "+14155550199",
    })
    const api = createApiClient({ app: makeTestApp(session, fake.service) })
    const denied = await api.post(`/api/v1/calling/${noConsent.id}/recordings`, {
      url: "s3://recordings/x.mp3",
    })
    expect(denied.status).toBe(409)
    denied.expectError("RECORDING_CONSENT_REQUIRED")

    const consented = await fake.service.logCall(ctx, {
      direction: "outbound",
      fromNumber: "+14155550100",
      toNumber: "+14155550199",
      recordingConsent: true,
    })
    const ok = await api.post(`/api/v1/calling/${consented.id}/recordings`, {
      url: "s3://recordings/y.mp3",
      durationSeconds: 30,
    })
    expect(ok.status).toBe(201)
    const detail = await api.get(`/api/v1/calling/${consented.id}`)
    const body = detail.expectSuccess().data as { recordings: { url: string }[] }
    expect(body.recordings).toHaveLength(1)
    expect(body.recordings[0]?.url).toBe("s3://recordings/y.mp3")
  })
})
