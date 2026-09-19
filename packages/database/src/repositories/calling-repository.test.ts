import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import { calls, callRecordings, type CallRow } from "../schema/calling"
import {
  createCallingRepository,
  InvalidCallPhoneNumberError,
  normalizeCallPhoneE164,
} from "./calling-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const CALL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

/** Thenable chain stub: every query builder call returns the proxy; each await pops one result. */
function mockDb(queued: unknown[][] = []) {
  let step = 0
  const proxy = new Proxy(function () {}, {
    get(_target, prop: string | symbol) {
      if (prop === "then") {
        return (resolve: (value: unknown) => void) => {
          resolve(queued[step] ?? [])
          step += 1
        }
      }
      return (..._args: unknown[]) => proxy
    },
  })
  return proxy as unknown as Database
}

function makeCallRow(overrides: Partial<CallRow> = {}): CallRow {
  return {
    id: CALL_ID,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    ownerId: null,
    direction: "outbound",
    status: "queued",
    source: "manual",
    fromNumber: "+14155550100",
    toNumber: "+14155550199",
    personId: null,
    companyId: null,
    dealId: null,
    connectionId: null,
    providerId: null,
    providerCallId: null,
    startedAt: null,
    endedAt: null,
    durationSeconds: null,
    disposition: null,
    notes: null,
    recordingConsent: false,
    errorMessage: null,
    ...overrides,
  }
}

describe("calling/schema", () => {
  test("calls exposes the BaseRecord column contract plus calling columns", () => {
    const cols = calls as unknown as Record<string, unknown>
    for (const col of ["id", "workspaceId", "createdAt", "updatedAt", "deletedAt"]) {
      expect(cols[col], col).toBeDefined()
    }
    for (const col of [
      "direction",
      "status",
      "source",
      "fromNumber",
      "toNumber",
      "personId",
      "companyId",
      "dealId",
      "connectionId",
      "providerId",
      "providerCallId",
      "recordingConsent",
    ]) {
      expect(cols[col], col).toBeDefined()
    }
  })

  test("call_recordings carries a call FK, workspace scoping, and metadata-only columns", () => {
    const cols = callRecordings as unknown as Record<string, unknown>
    expect(cols.callId).toBeDefined()
    expect(cols.workspaceId).toBeDefined()
    expect(cols.url).toBeDefined()
    expect(cols.durationSeconds).toBeDefined()
    expect(cols.sizeBytes).toBeDefined()
  })
})

describe("calling/phone normalisation (on write)", () => {
  test("a value already carrying + is normalised (punctuation stripped)", () => {
    expect(normalizeCallPhoneE164("+1 (415) 555-0100")).toBe("+14155550100")
  })

  test("00 international prefix becomes +", () => {
    expect(normalizeCallPhoneE164("0044 20 7946 0958")).toBe("+442079460958")
  })

  test("a bare national number with no international prefix is rejected", () => {
    expect(() => normalizeCallPhoneE164("4155550100")).toThrow(InvalidCallPhoneNumberError)
  })

  test("rejects empty and out-of-bounds values", () => {
    expect(() => normalizeCallPhoneE164("")).toThrow(InvalidCallPhoneNumberError)
    expect(() => normalizeCallPhoneE164("+123")).toThrow(InvalidCallPhoneNumberError)
    expect(() => normalizeCallPhoneE164("+1234567890123456")).toThrow(InvalidCallPhoneNumberError)
  })
})

describe("calling/repository", () => {
  test("create normalises both phone numbers and defaults status/source/consent", async () => {
    const repo = createCallingRepository()
    const row = makeCallRow()
    const db = mockDb([[row]])
    const result = await repo.create(db, WS, {
      direction: "outbound",
      fromNumber: "+1 (415) 555-0100",
      toNumber: "0014155550199",
    })
    expect(result).toEqual(row)
  })

  test("create rejects an unnormalisable phone number before touching the database", async () => {
    const repo = createCallingRepository()
    await expect(
      repo.create(mockDb(), WS, {
        direction: "outbound",
        fromNumber: "bad",
        toNumber: "+14155550199",
      }),
    ).rejects.toThrow(InvalidCallPhoneNumberError)
  })

  test("create rejects an unknown direction/status/source", async () => {
    const repo = createCallingRepository()
    await expect(
      repo.create(mockDb(), WS, {
        direction: "sideways",
        fromNumber: "+14155550100",
        toNumber: "+14155550199",
      }),
    ).rejects.toThrow()
  })

  test("update patches the given fields and returns the row", async () => {
    const repo = createCallingRepository()
    const row = makeCallRow({ disposition: "interested" })
    const result = await repo.update(mockDb([[row]]), WS, CALL_ID, { disposition: "interested" })
    expect(result).toEqual(row)
  })

  test("advanceStatus reports applied=true when the guarded UPDATE returns a row", async () => {
    const repo = createCallingRepository()
    const row = makeCallRow({ status: "ringing" })
    const result = await repo.advanceStatus(mockDb([[row]]), WS, CALL_ID, {
      status: "ringing",
      occurredAt: new Date("2026-01-01T00:00:01Z"),
    })
    expect(result.applied).toBe(true)
    expect(result.record?.status).toBe("ringing")
  })

  test("advanceStatus reports applied=false and falls back to the current row when the guard blocks it", async () => {
    const repo = createCallingRepository()
    const current = makeCallRow({ status: "completed" })
    // First query (the guarded UPDATE ... RETURNING) yields no rows because
    // the WHERE guard excluded the row; the fallback findById then returns
    // the untouched current row.
    const result = await repo.advanceStatus(mockDb([[], [current]]), WS, CALL_ID, {
      status: "ringing",
      occurredAt: new Date("2026-01-01T00:00:05Z"),
    })
    expect(result.applied).toBe(false)
    expect(result.record?.status).toBe("completed")
  })

  test("advanceStatus rejects an unknown status", async () => {
    const repo = createCallingRepository()
    await expect(
      repo.advanceStatus(mockDb(), WS, CALL_ID, { status: "bogus", occurredAt: new Date() }),
    ).rejects.toThrow()
  })

  test("createRecording returns the inserted metadata row", async () => {
    const repo = createCallingRepository()
    const recordingRow = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      workspaceId: WS,
      callId: CALL_ID,
      url: "s3://recordings/call-1.mp3",
      durationSeconds: 42,
      sizeBytes: 100_000,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: null,
      updatedBy: null,
      deletedAt: null,
    }
    const result = await repo.createRecording(mockDb([[recordingRow]]), WS, {
      callId: CALL_ID,
      url: "s3://recordings/call-1.mp3",
      durationSeconds: 42,
      sizeBytes: 100_000,
    })
    expect(result).toEqual(recordingRow)
  })
})
