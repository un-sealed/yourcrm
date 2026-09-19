import { describe, expect, test } from "bun:test"
import { useUiStore, useWorkspaceStore } from "./store"

describe("web/store", () => {
  test("workspace selection updates", () => {
    useWorkspaceStore.getState().setWorkspace("ws-1", "Acme")
    expect(useWorkspaceStore.getState().workspaceId).toBe("ws-1")
  })

  test("toasts push and dismiss", () => {
    useUiStore.getState().pushToast({ title: "Saved" })
    const [first] = useUiStore.getState().toasts.slice(-1)
    expect(first!.title).toBe("Saved")
    useUiStore.getState().dismissToast(first!.id)
    expect(useUiStore.getState().toasts.find((t) => t.id === first!.id)).toBeUndefined()
  })
})
