import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"
import type { WebhookDnsResolverPort } from "./url-guard"
import type { WebhookAttemptOutcome } from "./retry"

/**
 * Outbound webhooks + public API keys — ports (spec 32-api-webhooks, P0).
 *
 * `@yourcrm/crm` has no database, no HTTP client and no queue, so the
 * service talks to the structural ports below and nothing else:
 *
 *   store        -> webhook_subscriptions   (api-webhooks-repository)
 *   deliveries   -> webhook_deliveries      (api-webhooks-repository)
 *   apiKeys      -> api_keys                (api-webhooks-repository)
 *   queue        -> BullMQ, via apps/worker's queue seam
 *   transport    -> the actual HTTPS POST
 *   resolveDns   -> the delivery-time SSRF re-check
 *   audit/events -> ../ports.ts (shared; never redeclared here)
 *
 * `transport` and `resolveDns` are ports for the same reason the stores
 * are: tests must be hermetic. No test in this module opens a socket or
 * asks a resolver anything — `docs/conventions.md` requires it, and a
 * webhook sender that can only be tested against the live internet is a
 * webhook sender nobody re-tests.
 */

/* ------------------------------- records ------------------------------ */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type WebhookSubscriptionRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  name: string
  targetUrl: string
  eventNames: string[]
  active: boolean
}

export type WebhookDeliveryRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  subscriptionId: string
  eventId: string
  eventName: string
  status: string
  body: string
  attemptCount: number
  maxAttempts: number
}

/**
 * Everything about an issued key EXCEPT the key. Safe to serialise: the
 * only key-derived values here are the non-secret prefix and last four.
 */
export type PublicApiKeyRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  name: string
  role: string
  keyPrefix: string
  lastFour: string
}

/** What the auth path needs from a presented key. Carries no key material. */
export type ResolvedPublicApiKey = {
  id: string
  workspaceId: string
  name: string
  role: string
  /** User who issued the key — the actor writes are attributed to. */
  createdBy: string | null
  expiresAt: Date | null
}

export type WebhookDeliveryAttempt = {
  attempt: number
  at: string
  outcome: WebhookAttemptOutcome
  statusCode: number | null
  durationMs: number
  responseSnippet: string | null
  error: string | null
}

/* -------------------------------- stores ------------------------------ */

export type WebhookSubscriptionListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  active?: boolean
  event?: string
}

export type WebhookSubscriptionListResult = {
  data: WebhookSubscriptionRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type CreateWebhookSubscriptionStoreInput = {
  name: string
  description?: string | null
  targetUrl: string
  eventNames: string[]
  active: boolean
  /** Plaintext. The store seals it; there is no plaintext column. */
  secret: string
}

export type WebhookSubscriptionStore = {
  list(
    workspaceId: string,
    query: WebhookSubscriptionListQuery,
  ): Promise<WebhookSubscriptionListResult>
  findById(workspaceId: string, id: string): Promise<WebhookSubscriptionRecord | null>
  /**
   * Active subscriptions listening for one event name. The dispatcher runs
   * off the bus with no session in hand, so this is scoped by the event's
   * own workspace id and nothing else.
   */
  findActiveForEvent(workspaceId: string, eventName: string): Promise<WebhookSubscriptionRecord[]>
  create(
    workspaceId: string,
    input: CreateWebhookSubscriptionStoreInput,
    actorId?: string,
  ): Promise<WebhookSubscriptionRecord>
  update(
    workspaceId: string,
    id: string,
    patch: Record<string, unknown>,
    actorId?: string,
  ): Promise<WebhookSubscriptionRecord | null>
  /** Seal and replace the signing secret. Returns metadata only. */
  rotateSecret(
    workspaceId: string,
    id: string,
    secret: string,
    actorId?: string,
  ): Promise<WebhookSubscriptionRecord | null>
  /**
   * The ONLY path to a plaintext signing secret. It has one caller — the
   * signer, inside `executeDelivery` — and takes no session, because the
   * worker has none. Never expose it through a route.
   */
  readSecret(subscriptionId: string): Promise<string | null>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  /**
   * Record a terminal delivery outcome against the subscription's health
   * counters and return the new consecutive-failure count.
   */
  recordOutcome(
    subscriptionId: string,
    outcome: { at: Date; status: string; failed: boolean },
  ): Promise<{ consecutiveFailures: number }>
}

export type WebhookDeliveryListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  subscriptionId?: string
  status?: string
  event?: string
}

export type WebhookDeliveryListResult = {
  data: WebhookDeliveryRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type CreateWebhookDeliveryStoreInput = {
  subscriptionId: string
  eventId: string
  eventName: string
  body: string
  maxAttempts: number
  replayOfId?: string | null
}

export type WebhookDeliveryStore = {
  list(workspaceId: string, query: WebhookDeliveryListQuery): Promise<WebhookDeliveryListResult>
  findById(workspaceId: string, id: string): Promise<WebhookDeliveryRecord | null>
  /** Worker path: resolve a queued delivery with no session in hand. */
  findForDelivery(deliveryId: string): Promise<WebhookDeliveryRecord | null>
  /**
   * Insert unless `(subscriptionId, eventId)` already exists, in which case
   * return the existing row with `created: false`. This is the idempotency
   * seam: it must be implemented as one atomic upsert against the UNIQUE
   * index, never as "SELECT then INSERT".
   */
  createIfAbsent(
    workspaceId: string,
    input: CreateWebhookDeliveryStoreInput,
  ): Promise<{ delivery: WebhookDeliveryRecord; created: boolean }>
  /**
   * Move `pending`/`failed` -> `delivering` and bump `attempt_count`,
   * atomically. Returns null when the row is already terminal or already
   * claimed — that null is what makes a duplicated job a no-op.
   */
  claim(deliveryId: string, at: Date): Promise<WebhookDeliveryRecord | null>
  /** Append the attempt and apply the retry decision. */
  recordAttempt(
    deliveryId: string,
    input: {
      attempt: WebhookDeliveryAttempt
      status: "succeeded" | "failed" | "dead_lettered"
      nextAttemptAt: Date | null
      deadLetterReason: string | null
      at: Date
    },
  ): Promise<WebhookDeliveryRecord | null>
}

export type PublicApiKeyListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  includeRevoked?: boolean
}

export type PublicApiKeyListResult = {
  data: PublicApiKeyRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type CreatePublicApiKeyStoreInput = {
  name: string
  role: string
  /** Plaintext. The store hashes it; there is no column for the key. */
  rawKey: string
  keyPrefix: string
  lastFour: string
  expiresAt?: Date | null
}

export type PublicApiKeyStore = {
  list(workspaceId: string, query: PublicApiKeyListQuery): Promise<PublicApiKeyListResult>
  findById(workspaceId: string, id: string): Promise<PublicApiKeyRecord | null>
  create(
    workspaceId: string,
    input: CreatePublicApiKeyStoreInput,
    actorId?: string,
  ): Promise<PublicApiKeyRecord>
  /**
   * Authentication path: hash the presented key and look the row up. Takes
   * no workspace, because the caller has not proven one yet — the row is
   * what establishes it. Returns null for unknown, revoked, soft-deleted
   * and expired keys alike, so a caller learns nothing from the difference.
   */
  findByRawKey(rawKey: string, now: Date): Promise<ResolvedPublicApiKey | null>
  touchLastUsed(id: string, at: Date): Promise<void>
  revoke(workspaceId: string, id: string, actorId?: string): Promise<PublicApiKeyRecord | null>
}

/* --------------------------- outbound ports --------------------------- */

/** One enqueue request. Mirrors the worker payload in apps/worker. */
export type WebhookDeliveryJobRequest = {
  workspaceId: string
  subscriptionId: string
  deliveryId: string
  eventId: string
  eventName: string
  /** Attempt this job will make, 1-based. */
  attempt: number
  correlationId?: string
  /** Backoff deadline for a retry. Absent means "as soon as possible". */
  runAt?: Date
}

/**
 * The only way a delivery leaves the request path. Deliberately narrow so
 * the BullMQ adapter is four lines and a Temporal one would be four
 * different lines.
 */
export type WebhookDeliveryQueuePort = {
  enqueueWebhookDelivery(request: WebhookDeliveryJobRequest): Promise<void>
}

export type WebhookTransportRequest = {
  url: string
  method: "POST"
  headers: Record<string, string>
  body: string
  timeoutMs: number
  /**
   * Addresses the SSRF guard just vetted. A transport that can pin its
   * socket should pin one of these — see the TOCTOU note in url-guard.ts.
   */
  resolvedAddresses: string[]
}

export type WebhookTransportResponse = {
  statusCode: number
  /** Trimmed by the service; a transport may return the whole body. */
  bodySnippet?: string | null
}

/**
 * The actual HTTPS POST. A thrown error means "no HTTP response happened"
 * (DNS, TLS, connection reset, timeout) and is classified as transient.
 */
export type WebhookTransportPort = (
  request: WebhookTransportRequest,
) => Promise<WebhookTransportResponse>

/* -------------------------------- deps -------------------------------- */

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type ApiWebhooksAuditInput = {
  workspaceId: string
  actorId?: string | null
  action: string
  object: string
  recordId?: string | null
  before?: unknown
  after?: unknown
  correlationId?: string | null
  source?: "user" | "automation" | "ai" | "integration" | "mcp"
}

export type ApiWebhooksServiceContext = ServiceContext

export type ApiWebhooksServiceDeps = {
  store: WebhookSubscriptionStore
  deliveries: WebhookDeliveryStore
  apiKeys: PublicApiKeyStore
  queue: WebhookDeliveryQueuePort
  transport: WebhookTransportPort
  audit: AuditWriter<ApiWebhooksAuditInput>
  events?: EventEmitter
  /** Delivery-time DNS re-check. Omitted only where no host needs one. */
  resolveDns?: WebhookDnsResolverPort
  /** Injectable clock — hermetic tests assert exact timestamps. */
  now?: () => Date
}
