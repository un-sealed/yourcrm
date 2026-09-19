import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { baseRecordSchema } from "@yourcrm/validation"
import { makeBaseRecord } from "./records"
import { freezeTime, resetIdCounter, type FrozenTime } from "./time"

describe("testing/records", () => {
  let clock: FrozenTime | null = null

  beforeEach(() => {
    resetIdCounter()
    clock = freezeTime("2026-06-01T08:30:00.000Z")
  })

  afterEach(() => {
    clock?.restore()
    clock = null
  })

  test("makeBaseRecord satisfies the BaseRecord contract", () => {
    const record = makeBaseRecord()
    expect(baseRecordSchema.safeParse(record).success).toBe(true)
    expect(record.createdAt).toBe("2026-06-01T08:30:00.000Z")
    expect(record.updatedAt).toBe("2026-06-01T08:30:00.000Z")
    expect(record.createdBy).toBe(record.updatedBy)
    expect(record.deletedAt).toBeNull()
  })

  test("overrides extend the contract without restating it", () => {
    const person = { ...makeBaseRecord({ workspaceId: "ws_acme" }), firstName: "Ada" }
    expect(person.workspaceId).toBe("ws_acme")
    expect(person.firstName).toBe("Ada")
    expect(baseRecordSchema.safeParse(person).success).toBe(true)
  })

  test("ids are unique across calls", () => {
    expect(makeBaseRecord().id).not.toBe(makeBaseRecord().id)
  })
})
