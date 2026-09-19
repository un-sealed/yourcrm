import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"

/**
 * Customer portal API client and view helpers (spec 45-customer-portal, P0).
 *
 * The portal is the only part of this app that is NOT behind the member
 * session. Everything here talks to `/api/v1/portal/*`, which authenticates
 * with the `yourcrm_portal_session` cookie — a different cookie, a different
 * table and a different resolver from the member session. The browser sends
 * it automatically because `apiFetch` already uses `credentials: "include"`.
 *
 * These types mirror the API's redacted DTOs exactly. There is intentionally
 * no field here for an owner, an internal note or a person id: if one ever
 * appears in a portal response it should look wrong in this file too.
 */

export type PortalIdentity = {
  identityId: string
  email: string
  displayName: string | null
  entitlements: { tickets: boolean; invoices: boolean; quotes: boolean }
}

export type PortalLineItem = {
  id: string
  description: string
  quantity: number
  unitAmountCents: number
  amountCents: number
}

export type PortalInvoice = {
  id: string
  number: string
  status: string
  currency: string
  issueDate: string | null
  dueDate: string | null
  totalCents: number
  amountPaidCents: number
  balanceDueCents: number
  overdue: boolean
  lineItems: PortalLineItem[]
}

export type PortalQuote = {
  id: string
  number: string
  status: string
  currency: string
  expiresAt: string | null
  terms: string | null
  subtotalCents: number
  discountCents: number
  taxCents: number
  grandTotalCents: number
  lineItems: PortalLineItem[]
}

export type PortalTicketComment = {
  id: string
  body: string
  authorName: string | null
  authorKind: "customer" | "agent"
  createdAt: string | null
}

export type PortalTicket = {
  id: string
  subject: string
  status: string
  priority: string | null
  createdAt: string | null
  updatedAt: string | null
  comments: PortalTicketComment[]
}

export type PortalListResponse<T> = {
  data: T[]
  pagination: { nextCursor: string | null; limit: number }
}

/**
 * The ONLY thing the login page ever says.
 *
 * The API answers 202 for a known and an unknown address alike; this message
 * is the UI half of that promise. Never replace it with "no account found",
 * and never branch on the response — that would hand an attacker the
 * customer list the API just refused to give them.
 */
export const PORTAL_GENERIC_LINK_MESSAGE =
  "If that email address has portal access, a sign-in link is on its way. The link expires in 15 minutes."

export const PORTAL_RATE_LIMITED_MESSAGE =
  "Too many sign-in attempts. Please wait a few minutes and try again."

/**
 * What to tell the customer after requesting a link.
 *
 * Every outcome except an explicit rate limit maps to the same sentence —
 * including network failures, because "we could not reach the server" and
 * "that address is not registered" must not be distinguishable to someone
 * probing addresses. A rate limit is safe to surface: it is keyed on what
 * the caller submitted, not on whether it exists.
 */
export function magicLinkFeedback(error: unknown): string {
  if (error instanceof ApiError && error.code === "RATE_LIMITED") return PORTAL_RATE_LIMITED_MESSAGE
  return PORTAL_GENERIC_LINK_MESSAGE
}

/** Human message for a failed portal read. 404 is phrased as "not available". */
export function portalErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Your session has expired. Please sign in again."
    if (error.status === 404) return "That item is not available."
    return error.message
  }
  return "Something went wrong. Please try again."
}

export function isPortalUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401
}

/** Minor units to a localised amount. Cents are integers; never use floats. */
export function formatMoneyCents(cents: number, currency: string): string {
  const amount = cents / 100
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount)
  } catch {
    // Unknown currency code: show the number and the raw code rather than throw.
    return `${amount.toFixed(2)} ${currency}`
  }
}

export function formatPortalDate(value: string | null): string {
  if (!value) return "—"
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return "—"
  return parsed.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
}

/** Subset of `BadgeTone` from `@yourcrm/ui` that the portal uses. */
export type PortalTone = "default" | "success" | "warning" | "destructive" | "info"

export function invoiceTone(invoice: Pick<PortalInvoice, "status" | "overdue">): PortalTone {
  if (invoice.status === "paid") return "success"
  if (invoice.overdue) return "destructive"
  return "info"
}

export function quoteTone(status: string): PortalTone {
  if (status === "accepted") return "success"
  if (status === "rejected") return "destructive"
  return "info"
}

export function ticketTone(status: string): PortalTone {
  if (status === "resolved" || status === "closed") return "success"
  if (status === "pending") return "warning"
  return "info"
}

/* --------------------------------- calls -------------------------------- */

export async function requestPortalMagicLink(email: string, signal?: AbortSignal): Promise<void> {
  await apiFetchRaw<{ data: { requested: boolean } }>("/api/v1/portal/auth/magic-link", {
    method: "POST",
    body: { email },
    signal,
  })
}

export async function exchangePortalToken(
  token: string,
  signal?: AbortSignal,
): Promise<{ identity: PortalIdentity; expiresAt: string }> {
  return apiFetch<{ identity: PortalIdentity; expiresAt: string }>("/api/v1/portal/auth/session", {
    method: "POST",
    body: { token },
    signal,
  })
}

export async function logoutPortal(): Promise<void> {
  await apiFetch<{ loggedOut: boolean }>("/api/v1/portal/auth/logout", { method: "POST" })
}

export function fetchPortalIdentity(signal?: AbortSignal): Promise<PortalIdentity> {
  return apiFetch<PortalIdentity>("/api/v1/portal/me", { signal })
}

export function listPortalInvoices(
  signal?: AbortSignal,
): Promise<PortalListResponse<PortalInvoice>> {
  return apiFetchRaw<PortalListResponse<PortalInvoice>>("/api/v1/portal/invoices", { signal })
}

export function getPortalInvoice(id: string, signal?: AbortSignal): Promise<PortalInvoice> {
  return apiFetch<PortalInvoice>(`/api/v1/portal/invoices/${encodeURIComponent(id)}`, { signal })
}

export function listPortalQuotes(signal?: AbortSignal): Promise<PortalListResponse<PortalQuote>> {
  return apiFetchRaw<PortalListResponse<PortalQuote>>("/api/v1/portal/quotes", { signal })
}

export function listPortalTickets(signal?: AbortSignal): Promise<PortalListResponse<PortalTicket>> {
  return apiFetchRaw<PortalListResponse<PortalTicket>>("/api/v1/portal/tickets", { signal })
}

export function getPortalTicket(id: string, signal?: AbortSignal): Promise<PortalTicket> {
  return apiFetch<PortalTicket>(`/api/v1/portal/tickets/${encodeURIComponent(id)}`, { signal })
}
