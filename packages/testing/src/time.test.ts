import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createIdGenerator, freezeTime, nextId, resetIdCounter, type FrozenTime } from "./time"

describe("testing/time", () => {
  let clock: FrozenTime | null = null

  beforeEach(() => {
    resetIdCounter()
  })

  afterEach(() => {
    clock?.restore()
    clock = null
  })

  test("freezeTime pins Date.now and new Date()", () => {
    clock = freezeTime("2026-03-15T12:00:00.000Z")
    expect(Date.now()).toBe(new Date("2026-03-15T12:00:00.000Z").getTime())
    expect(new Date().toISOString()).toBe("2026-03-15T12:00:00.000Z")
  })

  test("freezeTime passes explicit date arguments through", () => {
    clock = freezeTime("2026-03-15T12:00:00.000Z")
    expect(new Date("2020-05-01T00:00:00.000Z").toISOString()).toBe("2020-05-01T00:00:00.000Z")
    expect(new Date(0).toISOString()).toBe("1970-01-01T00:00:00.000Z")
  })

  test("restore returns the real clock", () => {
    clock = freezeTime("2026-03-15T12:00:00.000Z")
    clock.restore()
    clock = null
    expect(new Date().getFullYear()).toBeGreaterThanOrEqual(2025)
  })

  test("freezeTime rejects invalid input", () => {
    expect(() => freezeTime("not-a-date")).toThrow("invalid ISO date")
  })

  test("nextId is deterministic after reset", () => {
    expect(nextId("ws")).toBe("ws_0001")
    expect(nextId("ws")).toBe("ws_0002")
    expect(nextId("user")).toBe("user_0003")
    resetIdCounter()
    expect(nextId("ws")).toBe("ws_0001")
  })

  test("createIdGenerator is seeded and independent", () => {
    const a = createIdGenerator({ prefix: "person", start: 7 })
    const b = createIdGenerator({ prefix: "person", start: 7 })
    expect([a(), a()]).toEqual([b(), b()])
    expect(a()).toBe("person_0009")
  })

  test("createIdGenerator defaults to test_0001", () => {
    expect(createIdGenerator()()).toBe("test_0001")
  })
})
