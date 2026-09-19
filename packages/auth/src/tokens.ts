import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * Session tokens: 32 CSPRNG bytes, base64url-encoded for cookie transport.
 * Only `hashSessionToken(token)` (SHA-256 hex) is persisted — the raw token
 * is never stored and never logged.
 */

export const SESSION_TOKEN_BYTES = 32

export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString("base64url")
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

/** Constant-time comparison of two token hashes. */
export function tokenHashesEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8")
  const bBuf = Buffer.from(b, "utf8")
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}
