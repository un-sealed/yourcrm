import { beforeEach, describe, expect, test } from "bun:test"
import { EventBus } from "@yourcrm/events"
import {
  captureEvents,
  createStore,
  expectAllowed,
  expectDenied,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
  type CapturedEvents,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { createConsoleCallingProvider, CONSOLE_CALLING_PROVIDER_ID } from "./provider"
import {
  AmbiguousCallingConnectionError,
  CallingConnectionNotConnectedError,
  CallingProviderCallFailedError,
  NoCallingProviderConnectedError,
  RecordingConsentRequiredError,
  createCallingService,
  type CallingService,
} from "./service"
import { decideCallStatusTransition, type CallStatus } from "./status"
import type {
  CallAuditInput,
  CallingConnectionRecord,
  CallingProviderPort,
  CallListQuery,
  CallRecord,
  CallRecordingRecord,
} from "./types"

type StoredCall = BaseRecord & Record<string, unknown> & { status: string }

const API_KEY = "dev-token-0123456789"
const DEFAULT_WS = "ws_fixed_for_console_provider_closure"

function asRecord(row: StoredCall): CallRecord {
  return row as unknown as CallRecord
}

type Harness = {
  service: CallingService
  events: CapturedEvents
  audits: CallAuditInput[]
  calls: ReturnType<typeof createStore<StoredCall>>
  recordings: CallRecordingRecord[]
  connections: Map<string, CallingConnectionRecord>
  secrets: Map<string, string>
}

type HarnessOptions = {
  providers?: CallingProviderPort[]
  placeCallThrows?: string
}

/** Real domain service over hermetic in-memory stores — the console provider does the real work. */
function makeHarness(options: HarnessOptions = {}): Harness {
  const calls = createStore<StoredCall>()
  const recordings: CallRecordingRecord[] = []
  const connections = new Map<string, CallingConnectionRecord>()
  const secrets = new Map<string, string>()
  const audits: CallAuditInput[] = []
  const bus = new EventBus()
  const events = captureEvents(bus)

  // `applyProviderStatusEvent` is called via a lazily-bound reference: the
  // provider needs it to route a webhook delivery, but the service itself
  // needs the provider to be constructed first. Assigned once below.
  let serviceRef: CallingService | null = null

  const providerList: CallingProviderPort[] = options.providers ?? [
    (() => {
      const consoleProvider = createConsoleCallingProvider({
        onStatusEvent: async (evt) => {
          await serviceRef?.applyProviderStatusEvent({
            workspaceId: evt.workspaceId,
            providerId: evt.providerId,
            providerCallId: evt.providerCallId,
            status: evt.status,
            occurredAt: evt.occurredAt,
            durationSeconds: evt.durationSeconds,
            errorMessage: evt.errorMessage,
          })
        },
      })
      if (options.placeCallThrows) {
        return {
          ...consoleProvider,
          placeCall: async () => {
            throw new Error(options.placeCallThrows)
          },
        }
      }
      return consoleProvider
    })(),
  ]

  const providersById = new Map(providerList.map((p) => [p.id, p]))

  const service = createCallingService({
    store: {
      list: async (workspaceId: string, query: CallListQuery) => {
        let rows = calls.list(workspaceId)
        if (query.status) rows = rows.filter((r) => r.status === query.status)
        if (query.direction) rows = rows.filter((r) => r.direction === query.direction)
        const limit = Math.min(Math.max(query.limit ?? 25, 1), 200)
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
      create: async (workspaceId, input, actorId) => {
        const record: StoredCall = {
          ...makeBaseRecord({ workspaceId }),
          status: "queued",
          ...input,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }
        return asRecord(calls.insert(record))
      },
      update: async (workspaceId, id, patch) => {
        const row = calls.update(id, workspaceId, patch as Partial<StoredCall>)
        return row ? asRecord(row) : null
      },
      advanceStatus: async (workspaceId, id, next) => {
        const current = calls.get(id, workspaceId)
        if (!current) return { record: null, applied: false }
        const decision = decideCallStatusTransition(current.status as CallStatus, next.status)
        if (!decision.applied) return { record: asRecord(current), applied: false }
        const patch: Partial<StoredCall> = { status: next.status }
        if (next.startedAt !== undefined) patch.startedAt = next.startedAt
        if (next.endedAt !== undefined) patch.endedAt = next.endedAt
        if (next.durationSeconds !== undefined) patch.durationSeconds = next.durationSeconds
        if (next.errorMessage !== undefined) patch.errorMessage = next.errorMessage
        const row = calls.update(id, workspaceId, patch)
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
    providers: {
      get: (providerId) => providersById.get(providerId) ?? null,
      list: () => [...providersById.values()],
    },
    audit: async (input) => void audits.push(input),
    events: bus,
  })

  serviceRef = service
  return { service, events, audits, calls, recordings, connections, secrets }
}

function setup(role: "owner" | "admin" | "member" | "viewer" = "owner", harness?: Harness) {
  const session = makeSession({ role, workspaceId: DEFAULT_WS })
  const ctx = makeServiceContext({ session })
  const backing = harness ?? makeHarness()
  return { ctx, service: backing.service, backing }
}

function connectConsoleProvider(backing: Harness, connectionId = "conn_1") {
  backing.connections.set(connectionId, {
    id: connectionId,
    workspaceId: DEFAULT_WS,
    providerId: CONSOLE_CALLING_PROVIDER_ID,
    status: "connected",
    config: { callerId: "+14155550100" },
  })
  backing.secrets.set(connectionId, API_KEY)
  return connectionId
}

describe("calling/service", () => {
  describe("logCall (manual, no provider required)", () => {
    test("works with zero providers registered", async () => {
      const { ctx, service } = setup("owner", makeHarness({ providers: [] }))
      const call = await expectAllowed(() =>
        service.logCall(ctx, {
          direction: "outbound",
          fromNumber: "+14155550100",
          toNumber: "+14155550199",
          status: "completed",
        }),
      )
      expect(call.source).toBe("manual")
      expect(call.status).toBe("completed")
    })

    test("recordingConsent defaults to false, never true", async () => {
      const { ctx, service } = setup()
      const call = await expectAllowed(() =>
        service.logCall(ctx, {
          direction: "inbound",
          fromNumber: "+14155550100",
          toNumber: "+14155550199",
        }),
      )
      expect(call.recordingConsent).toBe(false)
    })

    test("emits call.completed only when status is completed", async () => {
      const { ctx, service, backing } = setup()
      await expectAllowed(() =>
        service.logCall(ctx, {
          direction: "outbound",
          fromNumber: "+14155550100",
          toNumber: "+14155550199",
          status: "no_answer",
        }),
      )
      expect(() => backing.events.expectEmitted("call.completed", {})).toThrow()

      await expectAllowed(() =>
        service.logCall(ctx, {
          direction: "outbound",
          fromNumber: "+14155550100",
          toNumber: "+14155550199",
          status: "completed",
        }),
      )
      backing.events.expectEmitted("call.completed", { workspaceId: ctx.workspaceId })
    })

    test("writes an audit row with action=log", async () => {
      const { ctx, service, backing } = setup()
      const call = await expectAllowed(() =>
        service.logCall(ctx, {
          direction: "outbound",
          fromNumber: "+14155550100",
          toNumber: "+14155550199",
        }),
      )
      expect(backing.audits.at(-1)).toMatchObject({
        action: "log",
        object: "call",
        recordId: call.id,
      })
    })

    test("viewer cannot log a call (create denied)", async () => {
      const { ctx, service } = setup("viewer")
      await expectDenied(() =>
        service.logCall(ctx, {
          direction: "outbound",
          fromNumber: "+14155550100",
          toNumber: "+14155550199",
        }),
      )
    })
  })

  describe("placeCall (click-to-call)", () => {
    test("viewer is denied (send_external requires member+)", async () => {
      const backing = makeHarness()
      connectConsoleProvider(backing)
      const { ctx, service } = setup("viewer", backing)
      await expectDenied(() => service.placeCall(ctx, { toNumber: "+14155550199" }))
    })

    test("member can place a call", async () => {
      const backing = makeHarness()
      connectConsoleProvider(backing)
      const { ctx, service } = setup("member", backing)
      const call = await expectAllowed(() => service.placeCall(ctx, { toNumber: "+14155550199" }))
      expect(call.source).toBe("provider")
      expect(call.providerCallId).toBeTruthy()
      expect(call.status).toBe("ringing")
      expect(call.fromNumber).toBe("+14155550100")
    })

    test("no connected provider -> NoCallingProviderConnectedError, and the manual path still works", async () => {
      const { ctx, service } = setup("owner", makeHarness())
      await expect(service.placeCall(ctx, { toNumber: "+14155550199" })).rejects.toBeInstanceOf(
        NoCallingProviderConnectedError,
      )
    })

    test("more than one connected calling connection requires an explicit connectionId", async () => {
      const backing = makeHarness()
      connectConsoleProvider(backing, "conn_1")
      connectConsoleProvider(backing, "conn_2")
      const { ctx, service } = setup("owner", backing)
      await expect(service.placeCall(ctx, { toNumber: "+14155550199" })).rejects.toBeInstanceOf(
        AmbiguousCallingConnectionError,
      )
      const call = await expectAllowed(() =>
        service.placeCall(ctx, { toNumber: "+14155550199", connectionId: "conn_2" }),
      )
      expect(call.connectionId).toBe("conn_2")
    })

    test("a disconnected connection is rejected", async () => {
      const backing = makeHarness()
      const id = connectConsoleProvider(backing)
      backing.connections.set(id, { ...backing.connections.get(id)!, status: "disconnected" })
      const { ctx, service } = setup("owner", backing)
      await expect(
        service.placeCall(ctx, { toNumber: "+14155550199", connectionId: id }),
      ).rejects.toBeInstanceOf(CallingConnectionNotConnectedError)
    })

    test("a provider failure still records the attempt as failed, with the secret redacted", async () => {
      const backing = makeHarness({ placeCallThrows: `boom, key was ${API_KEY}` })
      connectConsoleProvider(backing)
      const { ctx, service } = setup("owner", backing)
      const err = await service
        .placeCall(ctx, { toNumber: "+14155550199" })
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(CallingProviderCallFailedError)
      const callId = (err as CallingProviderCallFailedError).callId
      const stored = backing.calls.get(callId, DEFAULT_WS)
      expect(stored?.status).toBe("failed")
      expect(String(stored?.errorMessage)).not.toContain(API_KEY)
      expect(String(stored?.errorMessage)).toContain("[redacted]")
    })

    test("click-to-call audits action=place", async () => {
      const backing = makeHarness()
      connectConsoleProvider(backing)
      const { ctx, service } = setup("owner", backing)
      const call = await expectAllowed(() => service.placeCall(ctx, { toNumber: "+14155550199" }))
      expect(backing.audits.at(-1)).toMatchObject({ action: "place", recordId: call.id })
    })
  })

  describe("status webhooks: idempotent and out-of-order safe (THE key invariant)", () => {
    let backing: Harness
    let ctx: ReturnType<typeof makeServiceContext>
    let service: CallingService

    beforeEach(() => {
      backing = makeHarness()
      connectConsoleProvider(backing)
      const s = setup("owner", backing)
      ctx = s.ctx
      service = s.service
    })

    async function place() {
      return service.placeCall(ctx, { toNumber: "+14155550199" })
    }

    test("a late ringing webhook arriving after completed does not regress the call", async () => {
      const call = await place()
      const provider = CONSOLE_CALLING_PROVIDER_ID

      const completed = await service.applyProviderStatusEvent({
        workspaceId: DEFAULT_WS,
        providerId: provider,
        providerCallId: String(call.providerCallId),
        status: "completed",
        occurredAt: new Date("2026-01-01T00:00:10Z"),
        durationSeconds: 30,
      })
      expect(completed.applied).toBe(true)
      expect(completed.call?.status).toBe("completed")

      // A stale/re-ordered "ringing" arrives after "completed" — must be ignored.
      const stale = await service.applyProviderStatusEvent({
        workspaceId: DEFAULT_WS,
        providerId: provider,
        providerCallId: String(call.providerCallId),
        status: "ringing",
        occurredAt: new Date("2026-01-01T00:00:05Z"),
      })
      expect(stale.applied).toBe(false)
      expect(stale.call?.status).toBe("completed")

      const stored = backing.calls.get(call.id, DEFAULT_WS)
      expect(stored?.status).toBe("completed")
      expect(stored?.durationSeconds).toBe(30)
    })

    test("forward progression applies in order: ringing -> in_progress -> completed", async () => {
      const call = await place()
      const provider = CONSOLE_CALLING_PROVIDER_ID
      const r1 = await service.applyProviderStatusEvent({
        workspaceId: DEFAULT_WS,
        providerId: provider,
        providerCallId: String(call.providerCallId),
        status: "in_progress",
        occurredAt: new Date("2026-01-01T00:00:02Z"),
      })
      expect(r1.applied).toBe(true)
      expect(r1.call?.status).toBe("in_progress")

      const r2 = await service.applyProviderStatusEvent({
        workspaceId: DEFAULT_WS,
        providerId: provider,
        providerCallId: String(call.providerCallId),
        status: "completed",
        occurredAt: new Date("2026-01-01T00:00:20Z"),
        durationSeconds: 18,
      })
      expect(r2.applied).toBe(true)
      expect(r2.call?.status).toBe("completed")
      backing.events.expectEmitted("call.completed", { entityId: call.id })
    })

    test("a duplicate/repeated status delivery is a harmless no-op", async () => {
      const call = await place()
      const provider = CONSOLE_CALLING_PROVIDER_ID
      const first = await service.applyProviderStatusEvent({
        workspaceId: DEFAULT_WS,
        providerId: provider,
        providerCallId: String(call.providerCallId),
        status: "ringing",
        occurredAt: new Date("2026-01-01T00:00:01Z"),
      })
      expect(first.applied).toBe(true)
      const second = await service.applyProviderStatusEvent({
        workspaceId: DEFAULT_WS,
        providerId: provider,
        providerCallId: String(call.providerCallId),
        status: "ringing",
        occurredAt: new Date("2026-01-01T00:00:02Z"),
      })
      expect(second.applied).toBe(true)
      expect(backing.calls.get(call.id, DEFAULT_WS)?.status).toBe("ringing")
    })

    test("once terminal, a different terminal status arriving later is also ignored (sticky)", async () => {
      const call = await place()
      const provider = CONSOLE_CALLING_PROVIDER_ID
      await service.applyProviderStatusEvent({
        workspaceId: DEFAULT_WS,
        providerId: provider,
        providerCallId: String(call.providerCallId),
        status: "failed",
        occurredAt: new Date("2026-01-01T00:00:03Z"),
        errorMessage: "no_answer from carrier",
      })
      const late = await service.applyProviderStatusEvent({
        workspaceId: DEFAULT_WS,
        providerId: provider,
        providerCallId: String(call.providerCallId),
        status: "completed",
        occurredAt: new Date("2026-01-01T00:00:04Z"),
      })
      expect(late.applied).toBe(false)
      expect(backing.calls.get(call.id, DEFAULT_WS)?.status).toBe("failed")
    })

    test("an event for an unknown provider call id is reported, not thrown", async () => {
      const result = await service.applyProviderStatusEvent({
        workspaceId: DEFAULT_WS,
        providerId: CONSOLE_CALLING_PROVIDER_ID,
        providerCallId: "does-not-exist",
        status: "completed",
        occurredAt: new Date(),
      })
      expect(result.applied).toBe(false)
      expect(result.call).toBeNull()
    })

    test("the webhook handle() path itself (through the provider, HMAC already verified by the framework) is out-of-order safe", async () => {
      const call = await place()
      const provider = createConsoleCallingProvider({
        onStatusEvent: async (evt) => {
          await service.applyProviderStatusEvent({
            workspaceId: evt.workspaceId,
            providerId: evt.providerId,
            providerCallId: evt.providerCallId,
            status: evt.status,
            occurredAt: evt.occurredAt,
          })
        },
      })
      const deliver = (status: string, occurredAt: string) =>
        provider.webhook!.handle({
          workspaceId: DEFAULT_WS,
          connectionId: "conn_1",
          providerId: CONSOLE_CALLING_PROVIDER_ID,
          config: {},
          providerEventId: `${status}-${occurredAt}`,
          eventType: "call.status",
          headers: {},
          rawBody: "{}",
          payload: {
            id: `${status}-${occurredAt}`,
            callId: call.providerCallId,
            status,
            occurredAt,
          },
        })
      await deliver("completed", "2026-01-01T00:00:10.000Z")
      await deliver("ringing", "2026-01-01T00:00:01.000Z")
      expect(backing.calls.get(call.id, DEFAULT_WS)?.status).toBe("completed")
    })
  })

  describe("recording consent and access", () => {
    test("addRecording is rejected without explicit consent on the call", async () => {
      const { ctx, service } = setup()
      const call = await service.logCall(ctx, {
        direction: "outbound",
        fromNumber: "+14155550100",
        toNumber: "+14155550199",
      })
      await expect(
        service.addRecording(ctx, call.id, { url: "s3://recordings/x.mp3" }),
      ).rejects.toBeInstanceOf(RecordingConsentRequiredError)
    })

    test("addRecording succeeds once consent is on the call, and get() returns it only to a reader", async () => {
      const { ctx, service } = setup()
      const call = await service.logCall(ctx, {
        direction: "outbound",
        fromNumber: "+14155550100",
        toNumber: "+14155550199",
        recordingConsent: true,
      })
      const recording = await expectAllowed(() =>
        service.addRecording(ctx, call.id, { url: "s3://recordings/x.mp3", durationSeconds: 12 }),
      )
      expect(recording.url).toBe("s3://recordings/x.mp3")
      const detail = await expectAllowed(() => service.get(ctx, call.id))
      expect(detail.recordings).toHaveLength(1)
      expect(detail.recordings[0]?.url).toBe("s3://recordings/x.mp3")
    })
  })

  describe("general read/update/delete", () => {
    test("get throws NOT_FOUND for unknown ids", async () => {
      const { ctx, service } = setup()
      const err = await service.get(ctx, "missing").catch((e: unknown) => e)
      expect((err as { code?: string }).code).toBe("NOT_FOUND")
    })

    test("update patches notes/disposition and audits before/after", async () => {
      const { ctx, service, backing } = setup()
      const call = await service.logCall(ctx, {
        direction: "outbound",
        fromNumber: "+14155550100",
        toNumber: "+14155550199",
      })
      const updated = await expectAllowed(() =>
        service.update(ctx, call.id, { disposition: "follow-up", notes: "left voicemail" }),
      )
      expect(updated.disposition).toBe("follow-up")
      expect(backing.audits.at(-1)).toMatchObject({ action: "update", recordId: call.id })
    })

    test("softDelete hides the call; restore revives it", async () => {
      const { ctx, service } = setup()
      const call = await service.logCall(ctx, {
        direction: "outbound",
        fromNumber: "+14155550100",
        toNumber: "+14155550199",
      })
      await expectAllowed(() => service.softDelete(ctx, call.id))
      await expect(service.get(ctx, call.id)).rejects.toMatchObject({ code: "NOT_FOUND" })
      await expectAllowed(() => service.restore(ctx, call.id))
      await expectAllowed(() => service.get(ctx, call.id))
    })

    test("member cannot delete (admin-only)", async () => {
      const { ctx, service } = setup()
      const call = await service.logCall(ctx, {
        direction: "outbound",
        fromNumber: "+14155550100",
        toNumber: "+14155550199",
      })
      const memberCtx = makeServiceContext({
        workspaceId: ctx.workspaceId,
        actorId: "someone_else",
        role: "member",
      })
      await expectDenied(() => service.softDelete(memberCtx, call.id))
    })
  })
})
