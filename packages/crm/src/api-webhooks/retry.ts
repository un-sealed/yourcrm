/**
 * Retry policy for outbound deliveries.
 *
 * `EVENTS-AND-INTEGRATIONS.md` states the rule this file implements:
 * "retry transient failures, dead-letter permanent failures". The two
 * halves matter equally — retrying a 404 for six hours is a self-inflicted
 * outage on the subscriber, and dead-lettering a 503 throws away an event
 * the subscriber would have accepted a minute later.
 *
 * Pure functions only: no clock, no I/O, so the schedule is asserted
 * exactly in tests rather than approximately.
 */

/** Total attempts before a transient failure becomes a dead letter. */
export const WEBHOOK_MAX_ATTEMPTS = 6

/** Delay before attempt 2. Doubles each time, capped below. */
export const WEBHOOK_BACKOFF_BASE_MS = 10_000

/** Ceiling on the backoff: 10s, 20s, 40s, 80s, 160s … never past this. */
export const WEBHOOK_BACKOFF_CAP_MS = 6 * 60 * 60 * 1000

/** Consecutive dead letters before a subscription is auto-deactivated. */
export const WEBHOOK_AUTO_DISABLE_AFTER = 20

/** How long one attempt may take before it counts as a transient failure. */
export const WEBHOOK_ATTEMPT_TIMEOUT_MS = 10_000

/** Characters of the subscriber's response body kept on the attempt row. */
export const WEBHOOK_RESPONSE_SNIPPET_LIMIT = 512

/**
 * Delay in milliseconds before the attempt AFTER `attempt`.
 *
 * Deterministic exponential backoff — deliberately without jitter. Jitter
 * exists to de-correlate a thundering herd of clients against one server;
 * here every delivery already has its own independent failure time, and an
 * unpredictable schedule would make the retry test assert "roughly", which
 * is how backoff bugs survive.
 */
export function webhookBackoffMs(attempt: number): number {
  const exponent = Math.max(0, Math.trunc(attempt) - 1)
  // Cap the exponent before shifting so 2 ** big never becomes Infinity.
  const uncapped = WEBHOOK_BACKOFF_BASE_MS * 2 ** Math.min(exponent, 32)
  return Math.min(uncapped, WEBHOOK_BACKOFF_CAP_MS)
}

export type WebhookAttemptOutcome = "succeeded" | "transient" | "permanent"

/**
 * Classify one HTTP response.
 *
 * - 2xx — accepted.
 * - 408 / 425 / 429 and every 5xx — the subscriber is overloaded, timing
 *   out or restarting. Transient.
 * - 3xx — permanent. Redirects are NOT followed: a subscriber that answers
 *   302 can otherwise redirect a signed payload to an address the SSRF
 *   guard just refused, which would make the guard decorative.
 * - every other 4xx — the subscriber rejected this request and will reject
 *   the identical retry. Permanent.
 */
export function classifyWebhookResponse(statusCode: number): WebhookAttemptOutcome {
  if (statusCode >= 200 && statusCode < 300) return "succeeded"
  if (statusCode === 408 || statusCode === 425 || statusCode === 429) return "transient"
  if (statusCode >= 500) return "transient"
  return "permanent"
}

export type WebhookRetryDecision = {
  /** Row status after this attempt. */
  status: "succeeded" | "failed" | "dead_lettered"
  /** When the next attempt is due, or null when there will not be one. */
  retryInMs: number | null
  /** Populated only for `dead_lettered`. */
  reason: string | null
}

/**
 * Next state for a delivery given one attempt's outcome.
 *
 * `attempt` is 1-based and is the attempt that just finished.
 */
export function decideWebhookRetry(input: {
  outcome: WebhookAttemptOutcome
  attempt: number
  maxAttempts: number
  /** Short description used as the dead-letter reason. */
  detail: string
}): WebhookRetryDecision {
  if (input.outcome === "succeeded") return { status: "succeeded", retryInMs: null, reason: null }
  if (input.outcome === "permanent") {
    return { status: "dead_lettered", retryInMs: null, reason: `permanent: ${input.detail}` }
  }
  if (input.attempt >= input.maxAttempts) {
    return {
      status: "dead_lettered",
      retryInMs: null,
      reason: `transient failure persisted for ${input.maxAttempts} attempts: ${input.detail}`,
    }
  }
  return { status: "failed", retryInMs: webhookBackoffMs(input.attempt), reason: null }
}

/** Trim a subscriber response for storage. Never store a whole body. */
export function webhookResponseSnippet(body: string | null | undefined): string | null {
  if (body === null || body === undefined) return null
  const text = body.trim()
  if (text === "") return null
  return text.slice(0, WEBHOOK_RESPONSE_SNIPPET_LIMIT)
}
