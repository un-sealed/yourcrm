import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * Inbound webhook signature verification.
 *
 * The FRAMEWORK verifies signatures, not providers: a provider only declares
 * where the HMAC lives and how it is encoded (`IntegrationWebhookSpecPort`),
 * so every connector gets the same constant-time check and there is one place
 * to audit.
 */

export type IntegrationSignatureAlgorithm = "sha1" | "sha256" | "sha512"

export type IntegrationSignatureEncoding = "hex" | "base64"

export type IntegrationSignatureInput = {
  /** The connection's stored `webhook_secret`, decrypted. */
  secret: string
  /** EXACT request bytes as received — re-serialising JSON breaks the HMAC. */
  rawBody: string
  algorithm: IntegrationSignatureAlgorithm
  encoding?: IntegrationSignatureEncoding
  /** Literal prefix in the header value, e.g. `sha256=`. */
  prefix?: string
}

export class IntegrationSignatureError extends Error {
  readonly code = "UNAUTHORIZED"
  constructor(message = "webhook signature verification failed") {
    super(message)
    this.name = "IntegrationSignatureError"
  }
}

/** Compute the expected signature header value (used by tests and senders). */
export function signIntegrationWebhookBody(input: IntegrationSignatureInput): string {
  const digest = createHmac(input.algorithm, input.secret)
    .update(input.rawBody, "utf8")
    .digest(input.encoding ?? "hex")
  return `${input.prefix ?? ""}${digest}`
}

/**
 * Constant-time signature check.
 *
 * Both sides are blinded through a per-call random-key HMAC before
 * comparison, so `timingSafeEqual` always sees two 32-byte buffers: neither
 * the byte values nor the LENGTH of the supplied signature can be recovered
 * by timing a series of requests. Returns false — never throws — for a
 * missing, malformed or wrong signature.
 */
export function verifyIntegrationWebhookSignature(
  input: IntegrationSignatureInput & { signature: string | null | undefined },
): boolean {
  const provided = input.signature?.trim()
  if (!provided || input.secret.length === 0) return false

  const prefix = input.prefix ?? ""
  if (prefix.length > 0 && !provided.startsWith(prefix)) return false

  const expected = signIntegrationWebhookBody(input)
  const blind = randomBytes(32)
  const fold = (value: string): Buffer => createHmac("sha256", blind).update(value, "utf8").digest()
  return timingSafeEqual(fold(expected), fold(provided))
}

/**
 * Verify or throw. The webhook route maps `IntegrationSignatureError` to 401:
 * an unverified caller is unauthenticated, not forbidden.
 */
export function requireIntegrationWebhookSignature(
  input: IntegrationSignatureInput & { signature: string | null | undefined },
): void {
  if (!verifyIntegrationWebhookSignature(input)) throw new IntegrationSignatureError()
}
