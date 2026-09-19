import type { BadgeTone } from "@yourcrm/ui"

/**
 * Wire types for `/app/api-webhooks`.
 *
 * Mirrors the API DTOs in `@yourcrm/crm/src/api-webhooks/schemas.ts`. Note
 * what is NOT here: no field anywhere in this file can hold a signing
 * secret or a raw API key, EXCEPT the two once-only creation responses
 * (`WebhookSubscriptionCreated`, `PublicApiKeyCreated`). The page shows
 * those values once, in a copy-me panel, and can never fetch them again —
 * because no endpoint returns them again.
 */

export type WebhookSubscription = {
  id: string
  workspaceId: string
  name: string
  description?: string | null
  targetUrl: string
  eventNames: string[]
  active: boolean
  /** Masked, e.g. `whsec_…4f2a`. Never the secret itself. */
  secretHint?: string | null
  secretRotatedAt?: string | null
  consecutiveFailures?: number
  lastDeliveryAt?: string | null
  lastDeliveryStatus?: string | null
  disabledAt?: string | null
  disabledReason?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

/** Returned by create and rotate ONLY. */
export type WebhookSubscriptionCreated = {
  subscription: WebhookSubscription
  signingSecret: string
}

export type WebhookDeliveryAttempt = {
  attempt: number
  at: string
  outcome: "succeeded" | "transient" | "permanent"
  statusCode: number | null
  durationMs: number
  responseSnippet: string | null
  error: string | null
}

export type WebhookDelivery = {
  id: string
  subscriptionId: string
  eventId: string
  eventName: string
  status: string
  attemptCount: number
  maxAttempts: number
  nextAttemptAt?: string | null
  attempts?: WebhookDeliveryAttempt[]
  lastStatusCode?: number | null
  lastResponseSnippet?: string | null
  lastDurationMs?: number | null
  lastError?: string | null
  deadLetterReason?: string | null
  replayOfId?: string | null
  createdAt?: string | null
}

export type PublicApiKey = {
  id: string
  workspaceId: string
  name: string
  role: string
  keyPrefix: string
  lastFour: string
  expiresAt?: string | null
  lastUsedAt?: string | null
  revokedAt?: string | null
  createdAt?: string | null
}

/** Returned by create ONLY. */
export type PublicApiKeyCreated = {
  apiKey: PublicApiKey
  key: string
}

export type SubscribableEvent = {
  name: string
  domain: string
}

export type Paginated<T> = {
  data: T[]
  pagination: { nextCursor: string | null; limit: number }
}

/* ------------------------------ presentation ----------------------------- */

/** Delivery status -> badge tone. Never colour alone: the label carries it. */
export function deliveryStatusTone(status: string): BadgeTone {
  if (status === "succeeded") return "success"
  if (status === "dead_lettered") return "destructive"
  if (status === "failed") return "warning"
  if (status === "delivering") return "info"
  return "secondary"
}

export function deliveryStatusLabel(status: string): string {
  if (status === "succeeded") return "Delivered"
  if (status === "dead_lettered") return "Dead-lettered"
  if (status === "failed") return "Retrying"
  if (status === "delivering") return "Sending"
  if (status === "pending") return "Queued"
  return status
}

export function subscriptionStatusTone(subscription: WebhookSubscription): BadgeTone {
  if (!subscription.active) return "secondary"
  if ((subscription.consecutiveFailures ?? 0) > 0) return "warning"
  return "success"
}

export function subscriptionStatusLabel(subscription: WebhookSubscription): string {
  if (!subscription.active) return subscription.disabledAt ? "Disabled" : "Paused"
  if ((subscription.consecutiveFailures ?? 0) > 0) {
    return `Failing (${subscription.consecutiveFailures})`
  }
  return "Active"
}

/** Group the event catalogue by domain for the picker's sections. */
export function groupEventsByDomain(
  events: readonly SubscribableEvent[],
): { domain: string; names: string[] }[] {
  const groups = new Map<string, string[]>()
  for (const event of events) {
    const bucket = groups.get(event.domain) ?? []
    bucket.push(event.name)
    groups.set(event.domain, bucket)
  }
  return [...groups.entries()]
    .map(([domain, names]) => ({ domain, names: [...names].sort() }))
    .sort((a, b) => a.domain.localeCompare(b.domain))
}

/** Toggle one event name in a selection, keeping it sorted and unique. */
export function toggleEventName(selected: readonly string[], name: string): string[] {
  const next = new Set(selected)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  return [...next].sort()
}

/** Short, human summary of an attempt row for the delivery log. */
export function describeAttempt(attempt: WebhookDeliveryAttempt): string {
  const code = attempt.statusCode === null ? "no response" : `HTTP ${attempt.statusCode}`
  return `Attempt ${attempt.attempt} · ${code} · ${attempt.durationMs}ms`
}

/** A delivery can only be replayed once it has stopped retrying itself. */
export function canReplay(delivery: WebhookDelivery): boolean {
  return delivery.status === "succeeded" || delivery.status === "dead_lettered"
}
