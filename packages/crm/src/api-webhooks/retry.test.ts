import { describe, expect, test } from "bun:test"
import {
  classifyWebhookResponse,
  decideWebhookRetry,
  webhookBackoffMs,
  webhookResponseSnippet,
  WEBHOOK_BACKOFF_BASE_MS,
  WEBHOOK_BACKOFF_CAP_MS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RESPONSE_SNIPPET_LIMIT,
} from "./retry"
import { isSubscribableEventName, SUBSCRIBABLE_EVENT_NAMES, WebhookEvents } from "./event-names"

describe("api-webhooks/retry/backoff", () => {
  test("the schedule is exponential from the base and capped", () => {
    expect(webhookBackoffMs(1)).toBe(WEBHOOK_BACKOFF_BASE_MS)
    expect(webhookBackoffMs(2)).toBe(WEBHOOK_BACKOFF_BASE_MS * 2)
    expect(webhookBackoffMs(3)).toBe(WEBHOOK_BACKOFF_BASE_MS * 4)
    expect(webhookBackoffMs(4)).toBe(WEBHOOK_BACKOFF_BASE_MS * 8)
    expect(webhookBackoffMs(5)).toBe(WEBHOOK_BACKOFF_BASE_MS * 16)
    // Never unbounded, never NaN/Infinity for an absurd attempt number.
    expect(webhookBackoffMs(99)).toBe(WEBHOOK_BACKOFF_CAP_MS)
    expect(webhookBackoffMs(0)).toBe(WEBHOOK_BACKOFF_BASE_MS)
  })
})

describe("api-webhooks/retry/classification", () => {
  test("2xx succeeds", () => {
    for (const code of [200, 201, 202, 204, 299]) {
      expect(classifyWebhookResponse(code)).toBe("succeeded")
    }
  })

  test("overload and server errors are transient", () => {
    for (const code of [408, 425, 429, 500, 502, 503, 504]) {
      expect(classifyWebhookResponse(code)).toBe("transient")
    }
  })

  test("client rejections and redirects are permanent", () => {
    // 3xx is permanent because redirects are not followed: a subscriber
    // must not be able to bounce a signed payload past the SSRF guard.
    for (const code of [301, 302, 307, 400, 401, 403, 404, 410, 422]) {
      expect(classifyWebhookResponse(code)).toBe("permanent")
    }
  })
})

describe("api-webhooks/retry/decision", () => {
  const base = { maxAttempts: WEBHOOK_MAX_ATTEMPTS, detail: "HTTP 503" }

  test("success settles immediately", () => {
    expect(decideWebhookRetry({ ...base, outcome: "succeeded", attempt: 1 })).toEqual({
      status: "succeeded",
      retryInMs: null,
      reason: null,
    })
  })

  test("PERMANENT failures dead-letter on the first attempt", () => {
    const decision = decideWebhookRetry({
      ...base,
      outcome: "permanent",
      attempt: 1,
      detail: "HTTP 404",
    })
    expect(decision.status).toBe("dead_lettered")
    expect(decision.retryInMs).toBeNull()
    expect(decision.reason).toContain("permanent")
  })

  test("TRANSIENT failures retry with backoff, then dead-letter at the ceiling", () => {
    for (let attempt = 1; attempt < WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
      const decision = decideWebhookRetry({ ...base, outcome: "transient", attempt })
      expect(decision.status).toBe("failed")
      expect(decision.retryInMs).toBe(webhookBackoffMs(attempt))
    }
    const last = decideWebhookRetry({
      ...base,
      outcome: "transient",
      attempt: WEBHOOK_MAX_ATTEMPTS,
    })
    expect(last.status).toBe("dead_lettered")
    expect(last.retryInMs).toBeNull()
    expect(last.reason).toContain(`${WEBHOOK_MAX_ATTEMPTS} attempts`)
  })
})

describe("api-webhooks/retry/snippet", () => {
  test("a response body is trimmed, never stored whole", () => {
    expect(webhookResponseSnippet(null)).toBeNull()
    expect(webhookResponseSnippet("   ")).toBeNull()
    expect(webhookResponseSnippet("ok")).toBe("ok")
    expect(webhookResponseSnippet("x".repeat(5000))?.length).toBe(WEBHOOK_RESPONSE_SNIPPET_LIMIT)
  })
})

describe("api-webhooks/event-names", () => {
  test("the catalogue comes from @yourcrm/events, sorted and de-duplicated", () => {
    expect(SUBSCRIBABLE_EVENT_NAMES).toContain("person.created")
    expect(SUBSCRIBABLE_EVENT_NAMES).toContain("deal.won")
    expect(SUBSCRIBABLE_EVENT_NAMES).toContain("integration.webhook_received")
    expect([...SUBSCRIBABLE_EVENT_NAMES]).toEqual([...SUBSCRIBABLE_EVENT_NAMES].sort())
    expect(new Set(SUBSCRIBABLE_EVENT_NAMES).size).toBe(SUBSCRIBABLE_EVENT_NAMES.length)
  })

  test("FEEDBACK LOOP: this module's own events are not subscribable", () => {
    for (const name of Object.values(WebhookEvents)) {
      expect(isSubscribableEventName(name)).toBe(false)
      expect(SUBSCRIBABLE_EVENT_NAMES).not.toContain(name)
    }
  })

  test("an invented event name is rejected", () => {
    expect(isSubscribableEventName("person.exploded")).toBe(false)
    expect(isSubscribableEventName("")).toBe(false)
    expect(isSubscribableEventName(42)).toBe(false)
  })
})
