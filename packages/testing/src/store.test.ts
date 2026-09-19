import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createStore } from "./store"
import { makeBaseRecord } from "./records"
import { freezeTime, resetIdCounter, type FrozenTime } from "./time"

type Widget = ReturnType<typeof makeBaseRecord> & { label: string }

function makeWidget(workspaceId: string, label = "w"): Widget {
  return { ...makeBaseRecord({ workspaceId }), label }
}

describe("testing/store", () => {
  let clock: FrozenTime | null = null

  beforeEach(() => {
    resetIdCounter()
    clock = freezeTime("2026-04-01T00:00:00.000Z")
  })

  afterEach(() => {
    clock?.restore()
    clock = null
  })

  test("insert/get/list round-trip within a workspace", () => {
    const store = createStore<Widget>()
    const a = store.insert(makeWidget("ws_1", "a"))
    store.insert(makeWidget("ws_1", "b"))
    store.insert(makeWidget("ws_2", "other"))
    expect(store.get(a.id, "ws_1")).toEqual(a)
    expect(store.get(a.id, "ws_2")).toBeNull()
    expect(store.list("ws_1").map((w) => w.label)).toEqual(["a", "b"])
    expect(store.list("ws_2")).toHaveLength(1)
  })

  test("update patches, guards identity fields, and bumps updatedAt", () => {
    const store = createStore<Widget>()
    const frozen = freezeTime("2026-05-01T00:00:00.000Z")
    try {
      const row = store.insert(makeWidget("ws_1", "a"))
      const next = store.update(row.id, "ws_1", { label: "a2", id: "hacked" as string })
      expect(next?.label).toBe("a2")
      expect(next?.id).toBe(row.id)
      expect(next?.updatedAt).toBe("2026-05-01T00:00:00.000Z")
      expect(store.update("missing", "ws_1", { label: "x" })).toBeNull()
      expect(store.update(row.id, "ws_other", { label: "x" })).toBeNull()
    } finally {
      frozen.restore()
    }
  })

  test("remove soft-deletes and restore revives", () => {
    const store = createStore<Widget>()
    const row = store.insert(makeWidget("ws_1"))
    expect(store.remove(row.id, "ws_1")).toBe(true)
    expect(store.get(row.id, "ws_1")).toBeNull()
    expect(store.list("ws_1")).toHaveLength(0)
    expect(store.remove(row.id, "ws_1")).toBe(false)
    expect(store.restore(row.id, "ws_1")).toBe(true)
    expect(store.get(row.id, "ws_1")?.id).toBe(row.id)
    expect(store.restore(row.id, "ws_1")).toBe(false)
  })

  test("clear forgets everything", () => {
    const store = createStore<Widget>()
    store.insert(makeWidget("ws_1"))
    store.clear()
    expect(store.list("ws_1")).toHaveLength(0)
  })
})
