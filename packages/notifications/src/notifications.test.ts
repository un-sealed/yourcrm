import { describe, expect, test } from "bun:test"
import { queueNotification } from "./notifications"

describe("notifications", () => {
  test("queues a typed notification", () => {
    const n = queueNotification({
      workspaceId: "w",
      userId: "u",
      type: "task.assigned",
      title: "Hi",
    })
    expect(n.id.length).toBeGreaterThan(0)
    expect(n.type).toBe("task.assigned")
  })

  test("rejects blank titles", () => {
    expect(() =>
      queueNotification({ workspaceId: "w", userId: "u", type: "x", title: "" }),
    ).toThrow()
  })
})
