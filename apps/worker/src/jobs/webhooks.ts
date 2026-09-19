import { z } from "zod"

/**
 * Outbound webhook delivery job (spec 32-api-webhooks, P0).
 *
 * This is the worker half of the queue seam. Every decision — which
 * subscriptions match, whether the target is still allowed by the SSRF
 * policy, how the body is signed, whether a failure is transient or
 * permanent, when to dead-letter — lives in
 * `@yourcrm/crm/src/api-webhooks`. The API's dispatcher records a delivery
 * row and enqueues it; this handler makes the HTTPS POST happen on a
 * worker instead of inside the request that created the record.
 *
 * Like `automation.ts` and `import-export.ts`, the payload schema is
 * restated here rather than imported: this file is the process boundary,
 * and spec 01 requires a job to be a pure function of ITS OWN validated
 * input. The canonical contract is `WebhookDeliveryJobRequest` in
 * `@yourcrm/crm/src/api-webhooks/types.ts`; keep the two in step.
 *
 * WHY THE SENDER IS INJECTED
 * --------------------------
 * `@yourcrm/worker` declares `@yourcrm/crm` but not `@yourcrm/database`,
 * and agents may not edit `package.json`, so this file cannot construct
 * the domain service itself. It takes a `WebhookSenderPort` that the
 * worker bootstrap registers once:
 *
 * ```ts
 * registerWebhookSender(async (payload) => apiWebhooksService.executeDelivery(payload))
 * ```
 *
 * Until that wiring exists the default sender fails loudly, so a
 * misconfigured deployment dead-letters visibly instead of silently
 * dropping every webhook.
 *
 * THE PROPERTIES ARE NOT RE-IMPLEMENTED HERE — and the transport cannot
 * weaken them either:
 *  - IDEMPOTENCY: `executeDelivery` claims the row with a conditional
 *    UPDATE before it does anything, so a BullMQ retry (or a duplicated
 *    job id) returns `skipped` and makes no request. The deterministic
 *    `webhookDeliveryJobId` below is the cheap second line: BullMQ ignores
 *    an `add()` whose id already exists.
 *  - SSRF: re-validated with DNS inside `executeDelivery`, immediately
 *    before the socket. There is no path from this file to a fetch.
 *  - RETRY/DEAD-LETTER: the schedule is the service's; this handler only
 *    reports what happened.
 */

/** Registered in `apps/worker/src/worker.ts`'s `JobHandlers` under this name. */
export const WEBHOOK_DELIVERY_JOB_NAME = "webhook.deliver"

export const webhookDeliveryJobPayloadSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  subscriptionId: z.string().min(1).max(128),
  deliveryId: z.string().min(1).max(128),
  /** Envelope id of the triggering event — half the idempotency key. */
  eventId: z.string().min(1).max(128),
  eventName: z.string().min(1).max(128),
  attempt: z.number().int().min(1).max(50),
  correlationId: z.string().max(64).optional(),
})

export type WebhookDeliveryJobPayload = z.infer<typeof webhookDeliveryJobPayloadSchema>

export type WebhookDeliveryJobResult = {
  deliveryId: string
  status: "succeeded" | "failed" | "dead_lettered" | "skipped"
  attempt: number
  statusCode: number | null
  retryInMs: number | null
  reason: string | null
}

/**
 * Deterministic transport-level job id.
 *
 * The authoritative guard is the UNIQUE (subscription_id, event_id) index
 * plus the claim. This keeps a redelivered event from even occupying a
 * worker slot. `attempt` is part of the id because a scheduled retry IS a
 * new job; without it, BullMQ would drop the retry as a duplicate of the
 * attempt that just failed.
 */
export function webhookDeliveryJobId(payload: { deliveryId: string; attempt: number }): string {
  return `${WEBHOOK_DELIVERY_JOB_NAME}:${payload.deliveryId}:${payload.attempt}`
}

/** What the bootstrap binds: usually `service.executeDelivery`. */
export type WebhookSenderPort = (
  payload: WebhookDeliveryJobPayload,
) => Promise<WebhookDeliveryJobResult>

export class WebhookSenderNotBoundError extends Error {
  readonly code = "WEBHOOK_SENDER_NOT_BOUND"
  constructor() {
    super("no webhook sender is registered: call registerWebhookSender() from the worker bootstrap")
    this.name = "WebhookSenderNotBoundError"
  }
}

const unboundSender: WebhookSenderPort = async () => {
  throw new WebhookSenderNotBoundError()
}

let sender: WebhookSenderPort = unboundSender

export function registerWebhookSender(next: WebhookSenderPort): void {
  sender = next
}

/** Restores the unbound default (tests, and a clean shutdown). */
export function resetWebhookSender(): void {
  sender = unboundSender
}

/**
 * Execute one queued delivery attempt. Retryable (the sender is
 * idempotent), observable (JSON log with delivery, event and correlation
 * ids) and validated at run time as well as at enqueue.
 */
export async function runWebhookDeliveryJob(input: unknown): Promise<WebhookDeliveryJobResult> {
  const payload = webhookDeliveryJobPayloadSchema.parse(input)
  const start = Date.now()
  const result = await sender(payload)
  console.log(
    JSON.stringify({
      level: "info",
      msg: "webhook_delivery_attempted",
      job: WEBHOOK_DELIVERY_JOB_NAME,
      workspaceId: payload.workspaceId,
      subscriptionId: payload.subscriptionId,
      deliveryId: payload.deliveryId,
      eventId: payload.eventId,
      event: payload.eventName,
      attempt: payload.attempt,
      status: result.status,
      statusCode: result.statusCode,
      // Never the target URL's query string, never a header, never a body:
      // a webhook payload is business data and a header carries a signature.
      retryInMs: result.retryInMs,
      durationMs: Date.now() - start,
      ...(payload.correlationId === undefined ? {} : { correlationId: payload.correlationId }),
    }),
  )
  return result
}
