import { describe, expect, test } from "bun:test"
import { verifyIntegrationWebhookSignature } from "../integrations/webhook-signature"
import {
  buildWebhookDeliveryHeaders,
  generateWebhookSigningSecret,
  signWebhookDelivery,
  webhookSignaturePayload,
  WEBHOOK_SECRET_PREFIX,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_PREFIX,
  WEBHOOK_TIMESTAMP_HEADER,
} from "./signing"

const secret = "whsec_test_secret_value_0123456789"
const body = JSON.stringify({ event: "person.created", eventId: "evt_1" })

describe("api-webhooks/signing", () => {
  test("a signature is sha256-prefixed hex and deterministic", () => {
    const signature = signWebhookDelivery({ secret, body, timestamp: 1_700_000_000 })
    expect(signature.startsWith(WEBHOOK_SIGNATURE_PREFIX)).toBe(true)
    expect(signature.slice(WEBHOOK_SIGNATURE_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/)
    expect(signWebhookDelivery({ secret, body, timestamp: 1_700_000_000 })).toBe(signature)
  })

  test("the subscriber verifies with the INBOUND helper — one HMAC implementation", () => {
    // This is the point of reusing ../integrations/webhook-signature.ts:
    // the code that verifies a provider's delivery to us also verifies
    // ours to a subscriber. If the two ever diverge, this test fails.
    const timestamp = 1_700_000_000
    const signature = signWebhookDelivery({ secret, body, timestamp })
    expect(
      verifyIntegrationWebhookSignature({
        secret,
        rawBody: webhookSignaturePayload(timestamp, body),
        algorithm: "sha256",
        encoding: "hex",
        prefix: WEBHOOK_SIGNATURE_PREFIX,
        signature,
      }),
    ).toBe(true)
  })

  test("REPLAY: the timestamp is signed, so editing it invalidates the signature", () => {
    const signature = signWebhookDelivery({ secret, body, timestamp: 1_700_000_000 })
    // An attacker who replays the captured body with a fresh timestamp
    // cannot produce a matching signature without the secret.
    expect(
      verifyIntegrationWebhookSignature({
        secret,
        rawBody: webhookSignaturePayload(1_700_009_999, body),
        algorithm: "sha256",
        encoding: "hex",
        prefix: WEBHOOK_SIGNATURE_PREFIX,
        signature,
      }),
    ).toBe(false)
  })

  test("a different secret or a tampered body does not verify", () => {
    const timestamp = 1_700_000_000
    const signature = signWebhookDelivery({ secret, body, timestamp })
    expect(signWebhookDelivery({ secret: `${secret}x`, body, timestamp })).not.toBe(signature)
    expect(signWebhookDelivery({ secret, body: `${body} `, timestamp })).not.toBe(signature)
  })

  test("headers carry the signature and timestamp, never the secret", () => {
    const headers = buildWebhookDeliveryHeaders({
      secret,
      body,
      timestamp: 1_700_000_000,
      eventName: "person.created",
      eventId: "evt_1",
      deliveryId: "dlv_1",
      attempt: 2,
    })
    expect(headers[WEBHOOK_SIGNATURE_HEADER]).toBe(
      signWebhookDelivery({ secret, body, timestamp: 1_700_000_000 }),
    )
    expect(headers[WEBHOOK_TIMESTAMP_HEADER]).toBe("1700000000")
    expect(headers["x-yourcrm-event"]).toBe("person.created")
    expect(headers["x-yourcrm-attempt"]).toBe("2")
    expect(Object.values(headers).join("|")).not.toContain(secret)
  })

  test("generated secrets are prefixed, unique and high-entropy", () => {
    const a = generateWebhookSigningSecret()
    const b = generateWebhookSigningSecret()
    expect(a.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true)
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThan(40)
  })
})
