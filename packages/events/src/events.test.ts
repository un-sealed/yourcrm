import { describe, expect, test } from "bun:test"
import { EventBus } from "./bus"
import { createEvent, eventEnvelopeSchema } from "./envelope"

describe("events", () => {
  test("envelope validates and carries workspace/actor", () => {
    const e = createEvent({ event: "person.created", workspaceId: "w1", actorId: "u1" })
    expect(eventEnvelopeSchema.safeParse(e).success).toBe(true)
  })

  test("bus delivers to matching + wildcard handlers", async () => {
    const bus = new EventBus()
    const seen: string[] = []
    bus.on("deal.won", async (e) => {
      seen.push(`exact:${e.event}`)
    })
    bus.on("*", async (e) => {
      seen.push(`wild:${e.event}`)
    })
    await bus.emit(createEvent({ event: "deal.won", workspaceId: "w" }))
    expect(seen).toContain("exact:deal.won")
    expect(seen).toContain("wild:deal.won")
  })
})
