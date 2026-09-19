import { describe, expect, test } from "bun:test"
import {
  canReplay,
  deliveryStatusLabel,
  deliveryStatusTone,
  describeAttempt,
  groupEventsByDomain,
  subscriptionStatusLabel,
  subscriptionStatusTone,
  toggleEventName,
  type WebhookSubscription,
} from "./types"

const subscription = (overrides: Partial<WebhookSubscription> = {}): WebhookSubscription => ({
  id: "sub_1",
  workspaceId: "ws_1",
  name: "Ops relay",
  targetUrl: "https://hooks.example.com/x",
  eventNames: ["person.created"],
  active: true,
  ...overrides,
})

describe("web/api-webhooks/presentation", () => {
  test("delivery status maps to a tone AND a label — never colour alone", () => {
    expect(deliveryStatusTone("succeeded")).toBe("success")
    expect(deliveryStatusTone("dead_lettered")).toBe("destructive")
    expect(deliveryStatusTone("failed")).toBe("warning")
    expect(deliveryStatusLabel("dead_lettered")).toBe("Dead-lettered")
    expect(deliveryStatusLabel("failed")).toBe("Retrying")
    // An unknown status degrades to itself rather than disappearing.
    expect(deliveryStatusLabel("weird")).toBe("weird")
  })

  test("a failing-but-active subscription reads differently from a disabled one", () => {
    expect(subscriptionStatusLabel(subscription())).toBe("Active")
    expect(subscriptionStatusLabel(subscription({ consecutiveFailures: 3 }))).toBe("Failing (3)")
    expect(subscriptionStatusTone(subscription({ consecutiveFailures: 3 }))).toBe("warning")
    expect(subscriptionStatusLabel(subscription({ active: false }))).toBe("Paused")
    expect(subscriptionStatusLabel(subscription({ active: false, disabledAt: "now" }))).toBe(
      "Disabled",
    )
  })

  test("the event picker groups by domain and sorts", () => {
    const groups = groupEventsByDomain([
      { name: "person.updated", domain: "person" },
      { name: "deal.won", domain: "deal" },
      { name: "person.created", domain: "person" },
    ])
    expect(groups.map((g) => g.domain)).toEqual(["deal", "person"])
    expect(groups[1]?.names).toEqual(["person.created", "person.updated"])
  })

  test("toggling an event keeps the selection unique and sorted", () => {
    expect(toggleEventName([], "person.created")).toEqual(["person.created"])
    expect(toggleEventName(["person.created"], "person.created")).toEqual([])
    expect(toggleEventName(["person.created"], "deal.won")).toEqual(["deal.won", "person.created"])
  })

  test("an attempt reads as one line, including a no-response failure", () => {
    expect(
      describeAttempt({
        attempt: 2,
        at: "2026-01-01T00:00:00Z",
        outcome: "transient",
        statusCode: 503,
        durationMs: 120,
        responseSnippet: "busy",
        error: "HTTP 503",
      }),
    ).toBe("Attempt 2 · HTTP 503 · 120ms")
    expect(
      describeAttempt({
        attempt: 1,
        at: "2026-01-01T00:00:00Z",
        outcome: "transient",
        statusCode: null,
        durationMs: 10_000,
        responseSnippet: null,
        error: "ECONNRESET",
      }),
    ).toContain("no response")
  })

  test("replay is offered only once a delivery has stopped retrying itself", () => {
    const base = {
      id: "dlv_1",
      subscriptionId: "sub_1",
      eventId: "evt_1",
      eventName: "person.created",
      attemptCount: 1,
      maxAttempts: 6,
    }
    expect(canReplay({ ...base, status: "succeeded" })).toBe(true)
    expect(canReplay({ ...base, status: "dead_lettered" })).toBe(true)
    // Offering replay mid-backoff would create a second delivery racing
    // the retry the queue has already scheduled.
    expect(canReplay({ ...base, status: "failed" })).toBe(false)
    expect(canReplay({ ...base, status: "pending" })).toBe(false)
    expect(canReplay({ ...base, status: "delivering" })).toBe(false)
  })
})
