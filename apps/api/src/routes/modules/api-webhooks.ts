import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  createApiWebhooksService,
  createFetchWebhookTransport,
  createNodeDnsResolver,
  createPublicApiKeySchema,
  createWebhookSubscriptionSchema,
  listSubscribableEvents,
  publicApiKeyQuerySchema,
  publicApiKeySchema,
  subscribableEventSchema,
  subscribeWebhookDispatcher,
  updateWebhookSubscriptionSchema,
  webhookDeliveryQuerySchema,
  webhookDeliverySchema,
  webhookSubscriptionQuerySchema,
  webhookSubscriptionSchema,
  WebhookUrlNotAllowedError,
  type ApiWebhooksService,
  type ResolvedPublicApiKey,
  type WebhookDeliveryJobRequest,
} from "@yourcrm/crm/src/api-webhooks"
import { getDb, writeAudit } from "@yourcrm/database"
import { createApiWebhooksRepository } from "@yourcrm/database/src/repositories/api-webhooks-repository"
import { getEventBus } from "@yourcrm/events"
import { PermissionDeniedError } from "@yourcrm/permissions"
import { errorEnvelope, paginatedEnvelopeSchema } from "@yourcrm/validation"
import { Hono } from "hono"
import type { Context } from "hono"
import { z } from "zod"
import type { AppEnv } from "../../hono-env"
import { requireSession } from "../../middleware/auth"
import { zodToJsonSchema } from "../../openapi/zod-to-json-schema"

/**
 * Outbound webhooks + public API keys (spec 32-api-webhooks, P0).
 *
 * Thin HTTP layer only: zod validation at the boundary, session from the
 * auth middleware, then straight into the domain service. Everything that
 * matters — the SSRF policy, HMAC signing, the retry/dead-letter schedule,
 * idempotency and the role clamp on issued keys — lives in
 * `@yourcrm/crm/src/api-webhooks`; this file only BINDS it:
 *
 *   store/deliveries/apiKeys -> api-webhooks repository (migration 0360)
 *   audit                    -> writeAudit
 *   events                   -> the in-process event bus
 *   queue                    -> the delivery queue seam (see `defaultQueue`)
 *   transport                -> the platform fetch, redirects off
 *   resolveDns               -> node resolver, for the delivery-time recheck
 *
 * NO RESPONSE HERE CAN CARRY A SECRET beyond the two once-only reveals:
 * `POST /subscriptions` and `POST /subscriptions/:id/secret` return the
 * new signing secret, `POST /keys` returns the new key, and the DTO
 * schemas for every other endpoint have nowhere to put one.
 *
 * INTEGRATION NOTES (both need a `package.json` change, which an agent may
 * not make):
 *
 *  1. `@yourcrm/api` declares neither `bullmq` nor `@yourcrm/worker`, so
 *     `defaultQueue()` records the enqueue as a structured log line
 *     instead of pushing to BullMQ, and deliveries stay `pending`.
 *     Swapping in the real adapter is a four-line change in one function:
 *
 *     ```ts
 *     await getQueue(QueueNames.Default).add(WEBHOOK_DELIVERY_JOB_NAME, request, {
 *       jobId: webhookDeliveryJobId(request),
 *       ...(request.runAt ? { delay: request.runAt.getTime() - Date.now() } : {}),
 *     })
 *     ```
 *
 *  2. The dispatcher subscription belongs in the app bootstrap
 *     (`apps/api/src/index.ts`), not in this factory: route construction
 *     happens in tests that emit unrelated events on the shared bus.
 *     `subscribeWebhookDeliveryDispatcher()` below is the one-line call.
 */

export const basePath = "/api-webhooks"

const subscriptionEnvelope = z.object({ data: webhookSubscriptionSchema.passthrough() })
const subscriptionListEnvelope = paginatedEnvelopeSchema(webhookSubscriptionSchema.passthrough())
const deliveryListEnvelope = paginatedEnvelopeSchema(webhookDeliverySchema.passthrough())
const apiKeyListEnvelope = paginatedEnvelopeSchema(publicApiKeySchema.passthrough())
const eventCatalogueEnvelope = z.object({ data: z.array(subscribableEventSchema) })

export type ApiWebhooksRouteDeps = {
  service?: ApiWebhooksService
}

/**
 * Queue binding. The domain service only knows
 * `WebhookDeliveryQueuePort`; the canonical job name, payload and
 * deterministic id live in `apps/worker/src/jobs/webhooks.ts`. See
 * integration note 1 in the file header.
 */
function defaultQueue() {
  return {
    enqueueWebhookDelivery: async (request: WebhookDeliveryJobRequest): Promise<void> => {
      console.log(
        JSON.stringify({
          level: "info",
          msg: "webhook_delivery_enqueued",
          job: "webhook.deliver",
          jobId: `webhook.deliver:${request.deliveryId}:${request.attempt}`,
          workspaceId: request.workspaceId,
          subscriptionId: request.subscriptionId,
          deliveryId: request.deliveryId,
          event: request.eventName,
          attempt: request.attempt,
          ...(request.runAt === undefined ? {} : { runAt: request.runAt.toISOString() }),
          ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId }),
        }),
      )
    },
  }
}

function defaultService(): ApiWebhooksService {
  const db = getDb()
  const repository = createApiWebhooksRepository()
  return createApiWebhooksService({
    store: {
      list: (workspaceId, query) => repository.listSubscriptions(db, { workspaceId, ...query }),
      findById: (workspaceId, id) => repository.findSubscriptionById(db, workspaceId, id),
      findActiveForEvent: (workspaceId, eventName) =>
        repository.findActiveSubscriptionsForEvent(db, workspaceId, eventName),
      create: (workspaceId, input, actorId) =>
        repository.createSubscription(db, workspaceId, input, actorId),
      update: (workspaceId, id, patch, actorId) =>
        repository.updateSubscription(db, workspaceId, id, patch, actorId),
      rotateSecret: (workspaceId, id, secret, actorId) =>
        repository.rotateSubscriptionSecret(db, workspaceId, id, secret, actorId),
      readSecret: (subscriptionId) => repository.readSubscriptionSecret(db, subscriptionId),
      softDelete: async (workspaceId, id, actorId) => {
        await repository.softDeleteSubscription(db, workspaceId, id, actorId)
      },
      recordOutcome: (subscriptionId, outcome) =>
        repository.recordSubscriptionOutcome(db, subscriptionId, outcome),
    },
    deliveries: {
      list: (workspaceId, query) => repository.listDeliveries(db, { workspaceId, ...query }),
      findById: (workspaceId, id) => repository.findDeliveryById(db, workspaceId, id),
      findForDelivery: (id) => repository.findDeliveryForWorker(db, id),
      createIfAbsent: (workspaceId, input) =>
        repository.createDeliveryIfAbsent(db, workspaceId, input),
      claim: (id, at) => repository.claimDelivery(db, id, at),
      recordAttempt: (id, input) => repository.recordDeliveryAttempt(db, id, input),
    },
    apiKeys: {
      list: (workspaceId, query) => repository.listApiKeys(db, { workspaceId, ...query }),
      findById: (workspaceId, id) => repository.findApiKeyById(db, workspaceId, id),
      create: (workspaceId, input, actorId) =>
        repository.createApiKey(db, workspaceId, input, actorId),
      findByRawKey: (rawKey, at) => repository.findApiKeyByRawKey(db, rawKey, at),
      touchLastUsed: (id, at) => repository.touchApiKeyLastUsed(db, id, at),
      revoke: (workspaceId, id, actorId) => repository.revokeApiKey(db, workspaceId, id, actorId),
    },
    queue: defaultQueue(),
    transport: createFetchWebhookTransport(),
    resolveDns: createNodeDnsResolver(),
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "user" })
    },
    events: getEventBus(),
  })
}

function serviceContextOf(c: Context<AppEnv>) {
  const session = c.get("session") as Session | null
  return {
    workspaceId: session?.workspaceId ?? "",
    actorId: session?.user.id ?? "",
    role: session ? roleInWorkspace(session) : "viewer",
    correlationId: c.get("requestId") as string | undefined,
  }
}

// Takes a bare `Context`: zod-validator's hook hands back an untyped one.
function invalid(c: Context, message: string, details?: unknown) {
  return c.json(
    errorEnvelope("VALIDATION_ERROR", message, c.req.header("x-request-id") ?? undefined, details),
    400,
  )
}

function mapError(c: Context<AppEnv>, err: unknown) {
  const requestId = c.get("requestId") as string | undefined
  if (err instanceof PermissionDeniedError) {
    return c.json(errorEnvelope("FORBIDDEN", err.message, requestId), 403)
  }
  if (err instanceof WebhookUrlNotAllowedError) {
    // The reason names the rule that fired ("in the blocked range 10/8"),
    // which is what an admin needs, and reveals nothing about the network.
    return c.json(errorEnvelope(err.code, err.message, requestId), 400)
  }
  if (err instanceof z.ZodError) {
    return c.json(
      errorEnvelope("VALIDATION_ERROR", "Invalid request body", requestId, err.flatten()),
      400,
    )
  }
  if (err instanceof Error) {
    const code = (err as { code?: string }).code
    if (code === "NOT_FOUND") return c.json(errorEnvelope(code, err.message, requestId), 404)
    if (code === "FORBIDDEN") return c.json(errorEnvelope(code, err.message, requestId), 403)
  }
  throw err
}

export function createRoutes(deps: ApiWebhooksRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  let cached: ApiWebhooksService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  /* ------------------------------ catalogue ----------------------------- */

  // The event picker's source of truth. Public to any signed-in caller:
  // it is the list of names `@yourcrm/events` exports, not workspace data.
  app.get("/events", requireSession(), (c) => c.json({ data: listSubscribableEvents() }))

  /* ---------------------------- subscriptions --------------------------- */

  app.get(
    "/subscriptions",
    requireSession(),
    zValidator("query", webhookSubscriptionQuerySchema, (result, c) => {
      if (!result.success) return invalid(c, "Invalid query parameters", result.error.flatten())
    }),
    async (c) => {
      try {
        return c.json(await service().listSubscriptions(serviceContextOf(c), c.req.valid("query")))
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post(
    "/subscriptions",
    requireSession(),
    zValidator("json", createWebhookSubscriptionSchema, (result, c) => {
      if (!result.success) return invalid(c, "Invalid request body", result.error.flatten())
    }),
    async (c) => {
      try {
        const created = await service().createSubscription(serviceContextOf(c), c.req.valid("json"))
        // The ONE place a signing secret is ever returned.
        return c.json({ data: created }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/subscriptions/:id", requireSession(), async (c) => {
    try {
      const found = await service().getSubscription(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: found })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.patch(
    "/subscriptions/:id",
    requireSession(),
    zValidator("json", updateWebhookSubscriptionSchema, (result, c) => {
      if (!result.success) return invalid(c, "Invalid request body", result.error.flatten())
    }),
    async (c) => {
      try {
        const updated = await service().updateSubscription(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: updated })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.delete("/subscriptions/:id", requireSession(), async (c) => {
    try {
      await service().deleteSubscription(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: { deleted: true } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  // Rotation, not retrieval: there is no GET that returns a secret.
  app.post("/subscriptions/:id/secret", requireSession(), async (c) => {
    try {
      const rotated = await service().rotateSigningSecret(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: rotated })
    } catch (err) {
      return mapError(c, err)
    }
  })

  /* ------------------------------ deliveries ---------------------------- */

  app.get(
    "/deliveries",
    requireSession(),
    zValidator("query", webhookDeliveryQuerySchema, (result, c) => {
      if (!result.success) return invalid(c, "Invalid query parameters", result.error.flatten())
    }),
    async (c) => {
      try {
        return c.json(await service().listDeliveries(serviceContextOf(c), c.req.valid("query")))
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/deliveries/:id", requireSession(), async (c) => {
    try {
      return c.json({ data: await service().getDelivery(serviceContextOf(c), c.req.param("id")) })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post("/deliveries/:id/replay", requireSession(), async (c) => {
    try {
      const replay = await service().replayDelivery(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: replay }, 201)
    } catch (err) {
      return mapError(c, err)
    }
  })

  /* ------------------------------- api keys ----------------------------- */

  app.get(
    "/keys",
    requireSession(),
    zValidator("query", publicApiKeyQuerySchema, (result, c) => {
      if (!result.success) return invalid(c, "Invalid query parameters", result.error.flatten())
    }),
    async (c) => {
      try {
        return c.json(await service().listApiKeys(serviceContextOf(c), c.req.valid("query")))
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post(
    "/keys",
    requireSession(),
    zValidator("json", createPublicApiKeySchema, (result, c) => {
      if (!result.success) return invalid(c, "Invalid request body", result.error.flatten())
    }),
    async (c) => {
      try {
        const created = await service().createApiKey(serviceContextOf(c), c.req.valid("json"))
        // The ONE place a raw key is ever returned.
        return c.json({ data: created }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.delete("/keys/:id", requireSession(), async (c) => {
    try {
      return c.json({ data: await service().revokeApiKey(serviceContextOf(c), c.req.param("id")) })
    } catch (err) {
      return mapError(c, err)
    }
  })

  return app
}

/**
 * Bootstrap hook: connect the in-process event bus to the webhook
 * dispatcher so domain events actually fan out. Call it ONCE from
 * `apps/api/src/index.ts`; route factories must not subscribe (see the
 * file header). Mirrors `subscribeAutomationDispatcher`.
 */
export function subscribeWebhookDeliveryDispatcher(service?: ApiWebhooksService): () => void {
  // Resolve the service lazily, on the first dispatched event — NOT at
  // boot. A default parameter would call getDb() during module bootstrap
  // and crash the API before it could serve anything.
  let resolved: ApiWebhooksService | undefined = service
  const lazy = new Proxy({} as ApiWebhooksService, {
    get(_t, prop: string | symbol) {
      resolved ??= defaultService()
      return Reflect.get(resolved as object, prop, resolved)
    },
  })
  return subscribeWebhookDispatcher(getEventBus(), lazy, (err) => {
    console.error(
      JSON.stringify({ level: "error", msg: "webhook_dispatch_failed", err: String(err) }),
    )
  })
}

/**
 * Key resolution for the integrator to wire (see
 * `apps/api/src/lib/api-key-auth.ts`). Exposed as a function rather than
 * as an edit to `middleware/auth.ts`, which another concern owns:
 *
 * ```ts
 * // apps/api/src/app.ts, immediately after app.use("*", auth()):
 * app.use("*", publicApiKeyAuth({ resolve: resolvePublicApiKey }))
 * ```
 *
 * Lazy for the same reason the dispatcher is: importing this module must
 * not open a database connection.
 */
export function resolvePublicApiKey(rawKey: string): Promise<ResolvedPublicApiKey | null> {
  return defaultService().resolveApiKey(rawKey)
}

export const openApiPaths = {
  "/api/v1/api-webhooks/events": {
    get: {
      summary: "List subscribable domain event names",
      operationId: "listWebhookEventCatalogue",
    },
  },
  "/api/v1/api-webhooks/subscriptions": {
    get: {
      summary: "List webhook subscriptions (cursor pagination, active/event filters)",
      operationId: "listWebhookSubscriptions",
    },
    post: {
      summary: "Create a webhook subscription (returns the signing secret once)",
      operationId: "createWebhookSubscription",
      requestBody: {
        content: {
          "application/json": { schema: zodToJsonSchema(createWebhookSubscriptionSchema) },
        },
      },
    },
  },
  "/api/v1/api-webhooks/subscriptions/{id}": {
    get: { summary: "Get a webhook subscription", operationId: "getWebhookSubscription" },
    patch: {
      summary: "Update a webhook subscription",
      operationId: "updateWebhookSubscription",
      requestBody: {
        content: {
          "application/json": { schema: zodToJsonSchema(updateWebhookSubscriptionSchema) },
        },
      },
    },
    delete: {
      summary: "Soft-delete a webhook subscription",
      operationId: "deleteWebhookSubscription",
    },
  },
  "/api/v1/api-webhooks/subscriptions/{id}/secret": {
    post: {
      summary: "Rotate the signing secret (returns the new secret once)",
      operationId: "rotateWebhookSigningSecret",
    },
  },
  "/api/v1/api-webhooks/deliveries": {
    get: {
      summary: "List webhook deliveries with attempt history",
      operationId: "listWebhookDeliveries",
    },
  },
  "/api/v1/api-webhooks/deliveries/{id}": {
    get: { summary: "Get one webhook delivery", operationId: "getWebhookDelivery" },
  },
  "/api/v1/api-webhooks/deliveries/{id}/replay": {
    post: { summary: "Replay a delivery as a new attempt", operationId: "replayWebhookDelivery" },
  },
  "/api/v1/api-webhooks/keys": {
    get: {
      summary: "List public API keys (never the keys themselves)",
      operationId: "listApiKeys",
    },
    post: {
      summary: "Issue a public API key (returns the raw key exactly once)",
      operationId: "createApiKey",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createPublicApiKeySchema) } },
      },
    },
  },
  "/api/v1/api-webhooks/keys/{id}": {
    delete: { summary: "Revoke a public API key", operationId: "revokeApiKey" },
  },
}

export {
  apiKeyListEnvelope,
  deliveryListEnvelope,
  eventCatalogueEnvelope,
  subscriptionEnvelope,
  subscriptionListEnvelope,
}
