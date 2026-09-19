import { randomBytes } from "node:crypto"
import { signIntegrationWebhookBody } from "../integrations/webhook-signature"

/**
 * Outbound delivery signing.
 *
 * This module is the OUTBOUND half of the same idea `../integrations`
 * already implements inbound, so it calls that module's
 * `signIntegrationWebhookBody()` rather than reaching for `createHmac`
 * again. One HMAC implementation, one place to audit, and a subscriber can
 * verify a YourCRM delivery with exactly the code YourCRM uses to verify
 * a provider's.
 *
 * WHAT IS SIGNED — `${timestamp}.${body}`, not the body alone. Signing the
 * body alone makes every delivery replayable forever: an attacker who
 * captures one valid (body, signature) pair can re-POST it to the
 * subscriber indefinitely and it stays valid. Binding the timestamp into
 * the signed string lets the subscriber reject anything older than its
 * tolerance, and means the timestamp header cannot be edited in flight.
 * (Stripe, GitHub and Slack all sign a timestamp-prefixed string for this
 * reason; a subscriber who already verifies one of those needs no new
 * concepts.)
 */

export const WEBHOOK_SIGNATURE_HEADER = "x-yourcrm-signature"
export const WEBHOOK_TIMESTAMP_HEADER = "x-yourcrm-timestamp"
export const WEBHOOK_EVENT_HEADER = "x-yourcrm-event"
export const WEBHOOK_EVENT_ID_HEADER = "x-yourcrm-event-id"
export const WEBHOOK_DELIVERY_HEADER = "x-yourcrm-delivery"
export const WEBHOOK_ATTEMPT_HEADER = "x-yourcrm-attempt"

export const WEBHOOK_SIGNATURE_PREFIX = "sha256="

export const WEBHOOK_USER_AGENT = "YourCRM-Webhooks/1"

/** Bytes of entropy in a generated signing secret. */
export const WEBHOOK_SECRET_BYTES = 32

/** Prefix on generated signing secrets, so a leaked one is recognisable. */
export const WEBHOOK_SECRET_PREFIX = "whsec_"

/**
 * Generate a signing secret. Shown to the admin exactly once, at creation
 * or rotation; only the sealed form is persisted.
 */
export function generateWebhookSigningSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(WEBHOOK_SECRET_BYTES).toString("base64url")}`
}

/** The exact string the HMAC is computed over. Subscribers rebuild this. */
export function webhookSignaturePayload(timestamp: number, body: string): string {
  return `${timestamp}.${body}`
}

export type WebhookSignatureInput = {
  secret: string
  /** EXACT body bytes that will be sent. */
  body: string
  /** Unix seconds. Travels in `x-yourcrm-timestamp` and is signed. */
  timestamp: number
}

/** `sha256=<hex>` over `${timestamp}.${body}`. */
export function signWebhookDelivery(input: WebhookSignatureInput): string {
  return signIntegrationWebhookBody({
    secret: input.secret,
    rawBody: webhookSignaturePayload(input.timestamp, input.body),
    algorithm: "sha256",
    encoding: "hex",
    prefix: WEBHOOK_SIGNATURE_PREFIX,
  })
}

export type WebhookDeliveryHeadersInput = WebhookSignatureInput & {
  eventName: string
  eventId: string
  deliveryId: string
  attempt: number
}

/** Headers for one attempt. Never carries the secret, only a digest of it. */
export function buildWebhookDeliveryHeaders(
  input: WebhookDeliveryHeadersInput,
): Record<string, string> {
  return {
    "content-type": "application/json",
    "user-agent": WEBHOOK_USER_AGENT,
    [WEBHOOK_EVENT_HEADER]: input.eventName,
    [WEBHOOK_EVENT_ID_HEADER]: input.eventId,
    [WEBHOOK_DELIVERY_HEADER]: input.deliveryId,
    [WEBHOOK_ATTEMPT_HEADER]: String(input.attempt),
    [WEBHOOK_TIMESTAMP_HEADER]: String(input.timestamp),
    [WEBHOOK_SIGNATURE_HEADER]: signWebhookDelivery(input),
  }
}
