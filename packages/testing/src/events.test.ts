import { describe, expect, test } from "bun:test"
import { createEvent, EventBus } from "@yourcrm/events"
import { captureEvents } from "./events"

describe("testing/events", () => {
  test("captures emitted events and proves one line assertions", async () => {
    const bus = new EventBus()
    const events = captureEvents(bus)
    try {
      await bus.emit(createEvent({ event: "person.created", workspaceId: "ws_1", entityId: "p_1" }))
      const found = events.expectEmitted("person.created", { entityId: "p_1" })
      expect(found.workspaceId).toBe("ws_1")
      expect(events.count("person.created")).toBe(1)
      expect(events.count()).toBe(1)
    } finally {
      events.release()
    }
  })

  test("expectEmitted fails descriptively when nothing matches", async () => {
    const bus = new EventBus()
    const events = captureEvents(bus)
    try {
      await bus.emit(createEvent({ event: "deal.won", workspaceId: "ws_1" }))
      expect(() => events.expectEmitted("person.created", { entityId: "p_1" })).toThrow(
        'no "person.created" event captured',
      )
      expect(() => events.expectEmitted("deal.won", { entityId: "missing" })).toThrow("missing")
    } finally {
      events.release()
    }
  })

  test("clear forgets events and release unsubscribes", async () => {
    const bus = new EventBus()
    const events = captureEvents(bus)
    await bus.emit(createEvent({ event: "deal.won", workspaceId: "ws_1" }))
    events.clear()
    expect(events.count()).toBe(0)
    events.release()
    await bus.emit(createEvent({ event: "deal.won", workspaceId: "ws_1" }))
    expect(events.count()).toBe(0)
  })

  test("matches after payloads", async () => {
    const bus = new EventBus()
    const events = captureEvents(bus)
    try {
      await bus.emit(
        createEvent({
          event: "person.updated",
          workspaceId: "ws_1",
          entityId: "p_1",
          after: { firstName: "Ada" },
        }),
      )
      events.expectEmitted("person.updated", { entityId: "p_1", after: { firstName: "Ada" } })
      expect(() =>
        events.expectEmitted("person.updated", { after: { firstName: "Grace" } }),
      ).toThrow("person.updated")
    } finally {
      events.release()
    }
  })
})
