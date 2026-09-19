import { randomBytes } from "node:crypto"
import { createEvent, getEventBus, type DomainEvent } from "@yourcrm/events"
import { requirePermission } from "@yourcrm/permissions"
import {
  generatePublicApiKey,
  looksLikePublicApiKey,
  PUBLIC_API_KEY_PREFIX,
  publicApiKeyLastFour,
  roleExceedsCeiling,
} from "./api-keys"
import { isSubscribableEventName, WebhookEvents } from "./event-names"
import {
  createPublicApiKeySchema,
  createWebhookSubscriptionSchema,
  publicApiKeyQuerySchema,
  updateWebhookSubscriptionSchema,
  webhookDeliveryQuerySchema,
  webhookSubscriptionQuerySchema,
} from "./schemas"
import {
  classifyWebhookResponse,
  decideWebhookRetry,
  WEBHOOK_ATTEMPT_TIMEOUT_MS,
  WEBHOOK_AUTO_DISABLE_AFTER,
  WEBHOOK_MAX_ATTEMPTS,
  webhookResponseSnippet,
  type WebhookAttemptOutcome,
} from "./retry"
import { buildWebhookDeliveryHeaders, generateWebhookSigningSecret } from "./signing"
import {
  assertDeliverableWebhookUrl,
  assertWebhookUrl,
  WebhookUrlNotAllowedError,
} from "./url-guard"
import type {
  ApiWebhooksServiceContext,
  ApiWebhooksServiceDeps,
  PublicApiKeyListResult,
  PublicApiKeyRecord,
  ResolvedPublicApiKey,
  WebhookDeliveryAttempt,
  WebhookDeliveryJobRequest,
  WebhookDeliveryListResult,
  WebhookDeliveryRecord,
  WebhookSubscriptionListResult,
  WebhookSubscriptionRecord,
} from "./types"

/* ------------------------------- errors ------------------------------- */

export class WebhookSubscriptionNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`webhook subscription ${id} not found`)
    this.name = "WebhookSubscriptionNotFoundError"
  }
}

export class WebhookDeliveryNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`webhook delivery ${id} not found`)
    this.name = "WebhookDeliveryNotFoundError"
  }
}

export class PublicApiKeyNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`api key ${id} not found`)
    this.name = "PublicApiKeyNotFoundError"
  }
}

/**
 * Spec 32 §8: "API key scopes must not exceed creator permissions." An
 * admin minting an owner-scoped key is privilege escalation with extra
 * steps, so it is refused at creation rather than papered over at use.
 */
export class PublicApiKeyRoleExceedsCreatorError extends Error {
  readonly code = "FORBIDDEN"
  constructor(requested: string, creator: string) {
    super(`an api key cannot be given the "${requested}" role by a "${creator}"`)
    this.name = "PublicApiKeyRoleExceedsCreatorError"
  }
}

/* ------------------------------ contract ------------------------------ */

export type WebhookSubscriptionCreated = {
  subscription: WebhookSubscriptionRecord
  /** Plaintext, returned exactly once. Never persisted unsealed. */
  signingSecret: string
}

export type PublicApiKeyCreated = {
  apiKey: PublicApiKeyRecord
  /** Plaintext, returned exactly once. Only its hash is persisted. */
  key: string
}

export type WebhookDispatchResult = {
  eventId: string
  eventName: string
  /** Active subscriptions that matched. */
  matched: number
  /** Deliveries newly created and queued. */
  enqueued: number
  /** Matches already recorded for this event — the idempotency skip. */
  duplicates: number
}

export type WebhookDeliveryExecution = {
  deliveryId: string
  /** `skipped` means the row was already settled or already in flight. */
  status: "succeeded" | "failed" | "dead_lettered" | "skipped"
  attempt: number
  statusCode: number | null
  /** Milliseconds until the retry this execution queued, if any. */
  retryInMs: number | null
  reason: string | null
}

/* ------------------------------ service ------------------------------- */

/**
 * Outbound webhooks + public API keys (spec 32-api-webhooks, P0).
 *
 * Every admin method calls `requirePermission()` FIRST, before any read or
 * write. Two methods deliberately do not, and both say why at their
 * definition: `dispatch` (runs off the event bus — there is no caller to
 * authorise, and it never returns data to anyone) and `resolveApiKey`
 * (it IS authentication; a permission check before knowing who the caller
 * is would be circular).
 *
 * The three properties that make this module safe rather than convenient:
 *
 *  - SSRF. `assertWebhookUrl` runs at save time; `assertDeliverableWebhookUrl`
 *    runs again, with DNS, immediately before every attempt. See url-guard.ts.
 *  - SECRETS NEVER LEAVE. `readSecret` has exactly one caller in this file
 *    (the signer, below) and no route reaches it. Signing secrets and raw
 *    API keys appear only in the two once-only create/rotate results.
 *  - IDEMPOTENCY. `dispatch` creates delivery rows through an atomic
 *    upsert on `(subscription_id, event_id)` and enqueues only what it
 *    actually created; `executeDelivery` claims a row before doing any
 *    work and no-ops when the claim fails. A redelivered bus event and a
 *    retried BullMQ job are both harmless.
 */
export function createApiWebhooksService(deps: ApiWebhooksServiceDeps) {
  const events = deps.events ?? getEventBus()
  const now = deps.now ?? (() => new Date())

  function permissionOf(ctx: ApiWebhooksServiceContext, object: string, action: "read" | "admin") {
    return {
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      role: ctx.role ?? "viewer",
      object,
      action,
    }
  }

  /* --------------------------- subscriptions -------------------------- */

  async function listSubscriptions(
    ctx: ApiWebhooksServiceContext,
    rawQuery: unknown,
  ): Promise<WebhookSubscriptionListResult> {
    // Read is admin-gated like the integrations catalogue: a subscription
    // row names an internal endpoint and its delivery history mirrors
    // business payloads, so it is not viewer-safe even without secrets.
    requirePermission(permissionOf(ctx, "webhook_subscription", "admin"))
    const query = webhookSubscriptionQuerySchema.parse(rawQuery)
    return deps.store.list(ctx.workspaceId, query)
  }

  async function getSubscription(
    ctx: ApiWebhooksServiceContext,
    id: string,
  ): Promise<WebhookSubscriptionRecord> {
    requirePermission(permissionOf(ctx, "webhook_subscription", "admin"))
    const found = await deps.store.findById(ctx.workspaceId, id)
    if (!found) throw new WebhookSubscriptionNotFoundError(id)
    return found
  }

  async function createSubscription(
    ctx: ApiWebhooksServiceContext,
    rawInput: unknown,
  ): Promise<WebhookSubscriptionCreated> {
    requirePermission(permissionOf(ctx, "webhook_subscription", "admin"))
    const input = createWebhookSubscriptionSchema.parse(rawInput)
    // The schema already checked it. So does this — the service must hold
    // even when it is called from a test, the MCP surface or a future
    // route that forgets the validator.
    assertWebhookUrl(input.targetUrl)

    const signingSecret = generateWebhookSigningSecret()
    const subscription = await deps.store.create(
      ctx.workspaceId,
      {
        name: input.name,
        description: input.description ?? null,
        targetUrl: input.targetUrl,
        eventNames: input.eventNames,
        active: input.active,
        secret: signingSecret,
      },
      ctx.actorId,
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "webhook_subscription",
      recordId: subscription.id,
      after: subscription,
      correlationId: ctx.correlationId,
    })
    return { subscription, signingSecret }
  }

  async function updateSubscription(
    ctx: ApiWebhooksServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<WebhookSubscriptionRecord> {
    requirePermission(permissionOf(ctx, "webhook_subscription", "admin"))
    const patch = updateWebhookSubscriptionSchema.parse(rawPatch)
    if (patch.targetUrl !== undefined) assertWebhookUrl(patch.targetUrl)

    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new WebhookSubscriptionNotFoundError(id)

    // Re-enabling a subscription clears the auto-disable bookkeeping, so a
    // fixed endpoint does not start life one failure from being turned off.
    const reactivating = patch.active === true && before.active !== true
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      reactivating
        ? { ...patch, disabledAt: null, disabledReason: null, consecutiveFailures: 0 }
        : { ...patch },
      ctx.actorId,
    )
    if (!after) throw new WebhookSubscriptionNotFoundError(id)

    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "webhook_subscription",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /**
   * Replace the signing secret and return the new one, once.
   *
   * Rotation is a replace, not a read: there is no endpoint, anywhere, that
   * returns the CURRENT secret. An admin who lost it rotates and updates
   * the subscriber — which is also the only honest answer, because the
   * ciphertext is the only copy the deployment has.
   */
  async function rotateSigningSecret(
    ctx: ApiWebhooksServiceContext,
    id: string,
  ): Promise<WebhookSubscriptionCreated> {
    requirePermission(permissionOf(ctx, "webhook_subscription", "admin"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new WebhookSubscriptionNotFoundError(id)

    const signingSecret = generateWebhookSigningSecret()
    const subscription = await deps.store.rotateSecret(
      ctx.workspaceId,
      id,
      signingSecret,
      ctx.actorId,
    )
    if (!subscription) throw new WebhookSubscriptionNotFoundError(id)

    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "rotate_secret",
      object: "webhook_subscription",
      recordId: id,
      // Audit records THAT it rotated, never the value on either side.
      before: { secretHint: before.secretHint ?? null },
      after: { secretHint: subscription.secretHint ?? null },
      correlationId: ctx.correlationId,
    })
    return { subscription, signingSecret }
  }

  async function deleteSubscription(
    ctx: ApiWebhooksServiceContext,
    id: string,
  ): Promise<WebhookSubscriptionRecord> {
    requirePermission(permissionOf(ctx, "webhook_subscription", "admin"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new WebhookSubscriptionNotFoundError(id)
    await deps.store.softDelete(ctx.workspaceId, id, ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "webhook_subscription",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  /* ----------------------------- deliveries --------------------------- */

  async function listDeliveries(
    ctx: ApiWebhooksServiceContext,
    rawQuery: unknown,
  ): Promise<WebhookDeliveryListResult> {
    requirePermission(permissionOf(ctx, "webhook_delivery", "admin"))
    const query = webhookDeliveryQuerySchema.parse(rawQuery)
    return deps.deliveries.list(ctx.workspaceId, query)
  }

  async function getDelivery(
    ctx: ApiWebhooksServiceContext,
    id: string,
  ): Promise<WebhookDeliveryRecord> {
    requirePermission(permissionOf(ctx, "webhook_delivery", "admin"))
    const found = await deps.deliveries.findById(ctx.workspaceId, id)
    if (!found) throw new WebhookDeliveryNotFoundError(id)
    return found
  }

  /**
   * Re-send a delivery.
   *
   * A replay is a NEW row, never a reset of the old one: the original's
   * attempt history is the evidence an operator is looking at when they
   * decide to replay, and overwriting it would destroy the thing that
   * justified the action. The new row carries a derived event id so the
   * `(subscription_id, event_id)` uniqueness still holds, and `replayOfId`
   * links the two.
   */
  async function replayDelivery(
    ctx: ApiWebhooksServiceContext,
    id: string,
  ): Promise<WebhookDeliveryRecord> {
    requirePermission(permissionOf(ctx, "webhook_delivery", "admin"))
    const original = await deps.deliveries.findById(ctx.workspaceId, id)
    if (!original) throw new WebhookDeliveryNotFoundError(id)

    const subscription = await deps.store.findById(ctx.workspaceId, original.subscriptionId)
    if (!subscription) throw new WebhookSubscriptionNotFoundError(original.subscriptionId)

    const replayEventId = `${original.eventId}:replay:${randomBytes(4).toString("hex")}`
    const { delivery } = await deps.deliveries.createIfAbsent(ctx.workspaceId, {
      subscriptionId: original.subscriptionId,
      eventId: replayEventId,
      eventName: original.eventName,
      body: original.body,
      maxAttempts: WEBHOOK_MAX_ATTEMPTS,
      replayOfId: original.id,
    })

    await deps.queue.enqueueWebhookDelivery({
      workspaceId: ctx.workspaceId,
      subscriptionId: original.subscriptionId,
      deliveryId: delivery.id,
      eventId: replayEventId,
      eventName: original.eventName,
      attempt: 1,
      ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
    })

    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "replay",
      object: "webhook_delivery",
      recordId: delivery.id,
      before: { deliveryId: original.id, status: original.status },
      after: { deliveryId: delivery.id, eventId: replayEventId },
      correlationId: ctx.correlationId,
    })
    return delivery
  }

  /* ------------------------------ dispatch ---------------------------- */

  /**
   * Entry point from the in-process event bus.
   *
   * NO PERMISSION CHECK, on purpose: there is no caller to authorise. A
   * domain event has already passed the permission check of whatever wrote
   * the record, this method returns nothing to anybody, and it is scoped
   * entirely by `event.workspaceId` — a subscription can only ever receive
   * events from its own workspace.
   *
   * Nothing is delivered here. Matching subscriptions get a delivery row
   * and a queued job; the HTTP request happens on a worker. Delivering
   * inline would put an arbitrary third-party endpoint's latency (and
   * availability) inside the request that created the record.
   */
  async function dispatch(event: DomainEvent): Promise<WebhookDispatchResult> {
    const result: WebhookDispatchResult = {
      eventId: event.eventId,
      eventName: event.event,
      matched: 0,
      enqueued: 0,
      duplicates: 0,
    }
    if (!event.workspaceId || !event.eventId) return result
    // Feedback-loop guard. `webhook.delivery_failed` is emitted BY this
    // module; a subscription to it would enqueue a delivery per failed
    // delivery, forever. `isSubscribableEventName` excludes this module's
    // own names, so the loop cannot start even from a hand-written row.
    if (!isSubscribableEventName(event.event)) return result

    const subscriptions = await deps.store.findActiveForEvent(event.workspaceId, event.event)
    result.matched = subscriptions.length
    if (subscriptions.length === 0) return result

    // The signed body IS the canonical envelope (`@yourcrm/events`): a
    // subscriber gets workspace, actor, entity, correlation id and schema
    // version, and — per the envelope rules — never a secret.
    const body = JSON.stringify(event)

    for (const subscription of subscriptions) {
      const { delivery, created } = await deps.deliveries.createIfAbsent(event.workspaceId, {
        subscriptionId: subscription.id,
        eventId: event.eventId,
        eventName: event.event,
        body,
        maxAttempts: WEBHOOK_MAX_ATTEMPTS,
      })
      if (!created) {
        result.duplicates += 1
        continue
      }
      await deps.queue.enqueueWebhookDelivery({
        workspaceId: event.workspaceId,
        subscriptionId: subscription.id,
        deliveryId: delivery.id,
        eventId: event.eventId,
        eventName: event.event,
        attempt: 1,
        ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
      })
      result.enqueued += 1
    }
    return result
  }

  /* -------------------------- delivery execution ---------------------- */

  async function settle(
    delivery: WebhookDeliveryRecord,
    subscription: WebhookSubscriptionRecord | null,
    attempt: WebhookDeliveryAttempt,
    detail: string,
    correlationId?: string,
  ): Promise<WebhookDeliveryExecution> {
    const at = now()
    const decision = decideWebhookRetry({
      outcome: attempt.outcome,
      attempt: attempt.attempt,
      maxAttempts: delivery.maxAttempts,
      detail,
    })
    await deps.deliveries.recordAttempt(delivery.id, {
      attempt,
      status: decision.status,
      nextAttemptAt:
        decision.retryInMs === null ? null : new Date(at.getTime() + decision.retryInMs),
      deadLetterReason: decision.reason,
      at,
    })

    if (decision.status === "failed" && decision.retryInMs !== null) {
      await deps.queue.enqueueWebhookDelivery({
        workspaceId: delivery.workspaceId,
        subscriptionId: delivery.subscriptionId,
        deliveryId: delivery.id,
        eventId: delivery.eventId,
        eventName: delivery.eventName,
        attempt: attempt.attempt + 1,
        runAt: new Date(at.getTime() + decision.retryInMs),
        ...(correlationId === undefined ? {} : { correlationId }),
      })
      return {
        deliveryId: delivery.id,
        status: "failed",
        attempt: attempt.attempt,
        statusCode: attempt.statusCode,
        retryInMs: decision.retryInMs,
        reason: detail,
      }
    }

    // Terminal: update subscription health, emit, and audit dead letters.
    const health = await deps.store.recordOutcome(delivery.subscriptionId, {
      at,
      status: decision.status,
      failed: decision.status === "dead_lettered",
    })

    await events.emit(
      createEvent({
        event:
          decision.status === "succeeded"
            ? WebhookEvents.DeliverySucceeded
            : WebhookEvents.DeliveryFailed,
        workspaceId: delivery.workspaceId,
        actorType: "system",
        entityType: "webhook_delivery",
        entityId: delivery.id,
        after: {
          subscriptionId: delivery.subscriptionId,
          eventId: delivery.eventId,
          eventName: delivery.eventName,
          attempt: attempt.attempt,
          statusCode: attempt.statusCode,
          durationMs: attempt.durationMs,
          ...(decision.reason === null ? {} : { reason: decision.reason }),
        },
        ...(correlationId === undefined ? {} : { correlationId }),
      }),
    )

    if (decision.status === "dead_lettered") {
      await deps.audit({
        workspaceId: delivery.workspaceId,
        actorId: null,
        action: "dead_letter",
        object: "webhook_delivery",
        recordId: delivery.id,
        after: {
          subscriptionId: delivery.subscriptionId,
          eventId: delivery.eventId,
          attempts: attempt.attempt,
          reason: decision.reason,
        },
        source: "integration",
        ...(correlationId === undefined ? {} : { correlationId }),
      })

      // A subscriber that has been dead in every one of the last N
      // deliveries is not coming back on its own. Stop sending, keep the
      // row, and leave the reason where an admin will read it.
      if (
        subscription &&
        subscription.active &&
        health.consecutiveFailures >= WEBHOOK_AUTO_DISABLE_AFTER
      ) {
        await deps.store.update(delivery.workspaceId, subscription.id, {
          active: false,
          disabledAt: at,
          disabledReason: `auto-disabled after ${health.consecutiveFailures} consecutive failed deliveries`,
        })
        await deps.audit({
          workspaceId: delivery.workspaceId,
          actorId: null,
          action: "auto_disable",
          object: "webhook_subscription",
          recordId: subscription.id,
          after: { consecutiveFailures: health.consecutiveFailures },
          source: "integration",
        })
      }
    }

    return {
      deliveryId: delivery.id,
      status: decision.status,
      attempt: attempt.attempt,
      statusCode: attempt.statusCode,
      retryInMs: null,
      reason: decision.reason ?? (decision.status === "succeeded" ? null : detail),
    }
  }

  /**
   * Perform ONE delivery attempt. Called from the worker, never from a
   * request.
   *
   * No permission check and no session: the delivery row carries its own
   * workspace, and the only thing this method can do is POST a body that
   * was decided when the row was created.
   *
   * Idempotent by construction — `claim()` is an atomic
   * `pending|failed -> delivering` transition, so a duplicated or retried
   * job that arrives after the delivery settled does nothing at all.
   */
  async function executeDelivery(
    request: WebhookDeliveryJobRequest,
  ): Promise<WebhookDeliveryExecution> {
    const claimed = await deps.deliveries.claim(request.deliveryId, now())
    if (!claimed) {
      return {
        deliveryId: request.deliveryId,
        status: "skipped",
        attempt: request.attempt,
        statusCode: null,
        retryInMs: null,
        reason: "delivery is already settled or in flight",
      }
    }

    const attemptNumber = claimed.attemptCount
    const startedAt = now()
    const baseAttempt = {
      attempt: attemptNumber,
      at: startedAt.toISOString(),
      statusCode: null as number | null,
      durationMs: 0,
      responseSnippet: null as string | null,
    }
    const fail = (
      outcome: WebhookAttemptOutcome,
      error: string,
      subscription: WebhookSubscriptionRecord | null,
    ) =>
      settle(
        claimed,
        subscription,
        { ...baseAttempt, outcome, error, durationMs: now().getTime() - startedAt.getTime() },
        error,
        request.correlationId,
      )

    const subscription = await deps.store.findById(claimed.workspaceId, claimed.subscriptionId)
    if (!subscription) {
      return fail("permanent", "subscription no longer exists", null)
    }
    if (!subscription.active) {
      return fail("permanent", "subscription is inactive", subscription)
    }

    // SSRF, second pass. The URL passed this policy when it was saved; DNS
    // may have moved since, so it is re-resolved and re-checked here,
    // immediately before the socket is opened.
    let target: Awaited<ReturnType<typeof assertDeliverableWebhookUrl>>
    try {
      target = await assertDeliverableWebhookUrl(subscription.targetUrl, deps.resolveDns)
    } catch (err) {
      const reason =
        err instanceof WebhookUrlNotAllowedError
          ? err.message
          : `target validation failed: ${err instanceof Error ? err.message : String(err)}`
      return fail("permanent", reason, subscription)
    }

    const secret = await deps.store.readSecret(subscription.id)
    if (secret === null || secret === "") {
      return fail("permanent", "subscription has no signing secret", subscription)
    }

    const timestamp = Math.floor(startedAt.getTime() / 1000)
    const headers = buildWebhookDeliveryHeaders({
      secret,
      body: claimed.body,
      timestamp,
      eventName: claimed.eventName,
      eventId: claimed.eventId,
      deliveryId: claimed.id,
      attempt: attemptNumber,
    })

    try {
      const response = await deps.transport({
        url: target.url.toString(),
        method: "POST",
        headers,
        body: claimed.body,
        timeoutMs: WEBHOOK_ATTEMPT_TIMEOUT_MS,
        resolvedAddresses: target.resolvedAddresses,
      })
      const outcome = classifyWebhookResponse(response.statusCode)
      const detail = `HTTP ${response.statusCode}`
      return settle(
        claimed,
        subscription,
        {
          attempt: attemptNumber,
          at: startedAt.toISOString(),
          outcome,
          statusCode: response.statusCode,
          durationMs: now().getTime() - startedAt.getTime(),
          responseSnippet: webhookResponseSnippet(response.bodySnippet),
          error: outcome === "succeeded" ? null : detail,
        },
        detail,
        request.correlationId,
      )
    } catch (err) {
      // No HTTP response happened at all: DNS, TLS, reset, timeout. Always
      // transient — the subscriber never got to reject anything.
      return fail("transient", err instanceof Error ? err.message : String(err), subscription)
    }
  }

  /* ------------------------------ api keys ---------------------------- */

  async function listApiKeys(
    ctx: ApiWebhooksServiceContext,
    rawQuery: unknown,
  ): Promise<PublicApiKeyListResult> {
    requirePermission(permissionOf(ctx, "api_key", "admin"))
    const query = publicApiKeyQuerySchema.parse(rawQuery)
    return deps.apiKeys.list(ctx.workspaceId, query)
  }

  async function createApiKey(
    ctx: ApiWebhooksServiceContext,
    rawInput: unknown,
  ): Promise<PublicApiKeyCreated> {
    requirePermission(permissionOf(ctx, "api_key", "admin"))
    const input = createPublicApiKeySchema.parse(rawInput)

    const creatorRole = ctx.role ?? "viewer"
    if (roleExceedsCeiling(input.role, creatorRole)) {
      throw new PublicApiKeyRoleExceedsCreatorError(input.role, creatorRole)
    }

    const key = generatePublicApiKey()
    const apiKey = await deps.apiKeys.create(
      ctx.workspaceId,
      {
        name: input.name,
        role: input.role,
        rawKey: key,
        keyPrefix: PUBLIC_API_KEY_PREFIX,
        lastFour: publicApiKeyLastFour(key),
        expiresAt: input.expiresAt ?? null,
      },
      ctx.actorId,
    )

    await events.emit(
      createEvent({
        event: WebhookEvents.ApiKeyCreated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "api_key",
        entityId: apiKey.id,
        // Metadata only. An event carrying the key would defeat the whole
        // point of hashing it — envelopes never include secrets.
        after: { id: apiKey.id, name: apiKey.name, role: apiKey.role, lastFour: apiKey.lastFour },
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "api_key",
      recordId: apiKey.id,
      after: { id: apiKey.id, name: apiKey.name, role: apiKey.role, lastFour: apiKey.lastFour },
      correlationId: ctx.correlationId,
    })
    return { apiKey, key }
  }

  async function revokeApiKey(
    ctx: ApiWebhooksServiceContext,
    id: string,
  ): Promise<PublicApiKeyRecord> {
    requirePermission(permissionOf(ctx, "api_key", "admin"))
    const before = await deps.apiKeys.findById(ctx.workspaceId, id)
    if (!before) throw new PublicApiKeyNotFoundError(id)
    const after = await deps.apiKeys.revoke(ctx.workspaceId, id, ctx.actorId)
    if (!after) throw new PublicApiKeyNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "revoke",
      object: "api_key",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /**
   * Resolve a presented `Authorization: Bearer <key>` to the key's row.
   *
   * NO PERMISSION CHECK: this is authentication, and a permission check
   * needs an authenticated actor to check — the order cannot be reversed.
   * The authorisation that matters happens afterwards, unchanged: the
   * caller turns this into a `Session` whose membership role is the key's
   * role, and every service method's `requirePermission()` then applies
   * exactly as it does for a cookie session.
   *
   * Returns null for unknown, malformed, revoked, deleted and expired keys
   * alike, so a caller cannot tell them apart.
   */
  async function resolveApiKey(rawKey: string): Promise<ResolvedPublicApiKey | null> {
    const presented = rawKey.trim()
    if (!looksLikePublicApiKey(presented)) return null
    const at = now()
    const resolved = await deps.apiKeys.findByRawKey(presented, at)
    if (!resolved) return null
    await deps.apiKeys.touchLastUsed(resolved.id, at)
    return resolved
  }

  return {
    listSubscriptions,
    getSubscription,
    createSubscription,
    updateSubscription,
    rotateSigningSecret,
    deleteSubscription,
    listDeliveries,
    getDelivery,
    replayDelivery,
    dispatch,
    executeDelivery,
    listApiKeys,
    createApiKey,
    revokeApiKey,
    resolveApiKey,
  }
}

export type ApiWebhooksService = ReturnType<typeof createApiWebhooksService>

/**
 * Subscribe the dispatcher to the in-process event bus.
 *
 * The composition root (`apps/api/src/index.ts`) owns this call — route
 * factories must not subscribe, because route construction happens in
 * tests that emit unrelated events on the shared bus. Mirrors
 * `subscribeWorkflowDispatcher` in ../automation.
 *
 * Returns the unsubscribe function.
 */
export function subscribeWebhookDispatcher(
  bus: {
    on(event: "*", handler: (event: DomainEvent) => void | Promise<void>): () => void
  },
  service: Pick<ApiWebhooksService, "dispatch">,
  onError?: (err: unknown, event: DomainEvent) => void,
): () => void {
  return bus.on("*", async (event: DomainEvent) => {
    // A webhook subscription must never be able to fail the business write
    // that triggered it — same rule the automation dispatcher follows.
    try {
      await service.dispatch(event)
    } catch (err) {
      onError?.(err, event)
    }
  })
}
