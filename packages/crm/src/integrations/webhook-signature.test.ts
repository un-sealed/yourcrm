import { describe, expect, test } from "bun:test"
import {
  IntegrationSignatureError,
  requireIntegrationWebhookSignature,
  signIntegrationWebhookBody,
  verifyIntegrationWebhookSignature,
} from "./webhook-signature"

const SECRET = "whsec_0123456789abcdef0123456789abcdef"
const BODY = JSON.stringify({ id: "evt_1", type: "message.received" })

describe("integrations/webhook signature", () => {
  test("a signature produced by the shared helper verifies", () => {
    const signature = signIntegrationWebhookBody({
      secret: SECRET,
      rawBody: BODY,
      algorithm: "sha256",
      prefix: "sha256=",
    })
    expect(signature.startsWith("sha256=")).toBe(true)
    expect(
      verifyIntegrationWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        algorithm: "sha256",
        prefix: "sha256=",
        signature,
      }),
    ).toBe(true)
  })

  test("a bad signature is rejected", () => {
    const tampered = signIntegrationWebhookBody({
      secret: "whsec_the-attackers-own-guessed-secret",
      rawBody: BODY,
      algorithm: "sha256",
      prefix: "sha256=",
    })
    expect(
      verifyIntegrationWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        algorithm: "sha256",
        prefix: "sha256=",
        signature: tampered,
      }),
    ).toBe(false)
  })

  test("a modified body invalidates a previously valid signature", () => {
    const signature = signIntegrationWebhookBody({
      secret: SECRET,
      rawBody: BODY,
      algorithm: "sha256",
    })
    expect(
      verifyIntegrationWebhookSignature({
        secret: SECRET,
        rawBody: `${BODY} `,
        algorithm: "sha256",
        signature,
      }),
    ).toBe(false)
  })

  test("missing, empty and truncated signatures are rejected, never thrown on", () => {
    const base = { secret: SECRET, rawBody: BODY, algorithm: "sha256" } as const
    const valid = signIntegrationWebhookBody(base)
    expect(verifyIntegrationWebhookSignature({ ...base, signature: null })).toBe(false)
    expect(verifyIntegrationWebhookSignature({ ...base, signature: undefined })).toBe(false)
    expect(verifyIntegrationWebhookSignature({ ...base, signature: "   " })).toBe(false)
    expect(verifyIntegrationWebhookSignature({ ...base, signature: valid.slice(0, 20) })).toBe(
      false,
    )
    expect(verifyIntegrationWebhookSignature({ ...base, signature: `${valid}00` })).toBe(false)
  })

  test("an empty stored secret can never verify", () => {
    expect(
      verifyIntegrationWebhookSignature({
        secret: "",
        rawBody: BODY,
        algorithm: "sha256",
        signature: signIntegrationWebhookBody({ secret: "", rawBody: BODY, algorithm: "sha256" }),
      }),
    ).toBe(false)
  })

  test("the declared prefix must be present", () => {
    const unprefixed = signIntegrationWebhookBody({
      secret: SECRET,
      rawBody: BODY,
      algorithm: "sha256",
    })
    expect(
      verifyIntegrationWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        algorithm: "sha256",
        prefix: "sha256=",
        signature: unprefixed,
      }),
    ).toBe(false)
  })

  test("base64 and sha512 variants round-trip", () => {
    for (const [algorithm, encoding] of [
      ["sha512", "base64"],
      ["sha1", "hex"],
    ] as const) {
      const signature = signIntegrationWebhookBody({
        secret: SECRET,
        rawBody: BODY,
        algorithm,
        encoding,
      })
      expect(
        verifyIntegrationWebhookSignature({
          secret: SECRET,
          rawBody: BODY,
          algorithm,
          encoding,
          signature,
        }),
      ).toBe(true)
    }
  })

  test("requireIntegrationWebhookSignature throws UNAUTHORIZED on a bad signature", () => {
    expect(() =>
      requireIntegrationWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        algorithm: "sha256",
        signature: "sha256=deadbeef",
      }),
    ).toThrow(IntegrationSignatureError)
    const err = new IntegrationSignatureError()
    expect(err.code).toBe("UNAUTHORIZED")
  })
})
