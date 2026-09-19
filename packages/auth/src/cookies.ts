import { SESSION_TTL_MS } from "./service"

/**
 * Session cookie helpers (framework-free string building; Hono and Next.js
 * adapters apply these values with their own cookie APIs).
 */

export const SESSION_COOKIE_NAME = "yourcrm_session"

export type SessionCookieOptions = {
  /** `Set-Cookie` Max-Age in seconds. Defaults to the session TTL. */
  maxAgeSeconds?: number
  /** Always Secure per spec (localhost is a secure context for cookies). */
  secure?: boolean
}

export function buildSessionCookie(token: string, options: SessionCookieOptions = {}): string {
  const maxAge = options.maxAgeSeconds ?? Math.floor(SESSION_TTL_MS / 1000)
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ]
  if (options.secure ?? true) parts.push("Secure")
  return parts.join("; ")
}

/** Expired cookie value for logout responses. */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

/** Extract the raw session token from a Cookie header value. */
export function parseSessionCookie(header: string | null | undefined): string | null {
  if (!header) return null
  for (const part of header.split(";")) {
    const index = part.indexOf("=")
    if (index === -1) continue
    const name = part.slice(0, index).trim()
    if (name !== SESSION_COOKIE_NAME) continue
    const value = decodeURIComponent(part.slice(index + 1).trim())
    return value || null
  }
  return null
}
