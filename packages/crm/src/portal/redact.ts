import { computeInvoiceTotals, isOverdue } from "../invoices"
import { computeQuoteTotals } from "../quotes"
import type { PortalSourceRecord } from "./types"

/**
 * Redaction: the last line of defence before CRM data reaches a customer.
 *
 * The repository already selects an explicit column list, so in the normal
 * path nothing internal is even fetched. These functions exist because the
 * ticket reader is an injected port implemented on ANOTHER branch by another
 * module, and because "the query only selects safe columns" is a property
 * that a future edit can quietly break. So every portal response is rebuilt
 * here, field by field, from an allow-list. Anything the allow-list does not
 * name cannot appear in a response, whatever the source row contains.
 *
 * The rules, in order of how much damage breaking them does:
 *
 *  1. ALLOW-LIST, NEVER DENY-LIST. `{ ...source, notes: undefined }` is not
 *     redaction: the next internal column added upstream ships to customers.
 *  2. COMMENT VISIBILITY FAILS CLOSED. A comment is public only if it says
 *     so. Missing, unknown or malformed visibility is treated as internal.
 *  3. NO INTERNAL IDS. `ownerId`, `personId`, `companyId`, `dealId`,
 *     `createdBy`, `updatedBy`, `workspaceId` never leave. The record's own
 *     id does, because the customer needs it to open the detail page.
 *  4. NO AUDIT, NO TIMELINE, NO INTERNAL NOTES. `notes` on an invoice, a
 *     quote or a payment is internal bookkeeping; a quote's `terms` is part
 *     of the customer-facing document and is the one free-text field kept.
 */

/** Keys that must never appear in any portal payload, at any depth. */
export const PORTAL_FORBIDDEN_KEYS = [
  "notes",
  "internalNotes",
  "ownerId",
  "assignedTo",
  "assigneeId",
  "personId",
  "companyId",
  "dealId",
  "quoteId",
  "workspaceId",
  "createdBy",
  "updatedBy",
  "deletedAt",
  "auditEvents",
  "customFields",
  "reference",
] as const

function readString(source: PortalSourceRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === "string" && value.trim() !== "") return value
  }
  return null
}

function readNumber(source: PortalSourceRecord, ...keys: string[]): number {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return 0
}

/** Dates cross the wire as ISO strings; `Date`, string and null all arrive. */
function readDate(source: PortalSourceRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key]
    if (value instanceof Date) return value.toISOString()
    if (typeof value === "string" && value.trim() !== "") return value
  }
  return null
}

export type PortalLineItemDto = {
  id: string
  description: string
  quantity: number
  unitAmountCents: number
  amountCents: number
}

export function toPortalLineItem(source: PortalSourceRecord): PortalLineItemDto {
  const quantity = readNumber(source, "quantity")
  const unitAmountCents = readNumber(source, "unitAmountCents")
  return {
    id: source.id,
    description: readString(source, "description") ?? "",
    quantity,
    unitAmountCents,
    amountCents: quantity * unitAmountCents,
  }
}

export type PortalInvoiceDto = {
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
  lineItems: PortalLineItemDto[]
}

/**
 * List row: money comes from the repository's correlated aggregates, so a
 * customer sees an amount without this module fetching line items per row.
 */
export function toPortalInvoiceSummary(
  source: PortalSourceRecord,
  now = new Date(),
): PortalInvoiceDto {
  const totalCents = readNumber(source, "totalCents")
  const amountPaidCents = readNumber(source, "paidCents", "amountPaidCents")
  const balanceDueCents = totalCents - amountPaidCents
  const status = readString(source, "status") ?? "sent"
  const dueDate = readDate(source, "dueDate")
  return {
    id: source.id,
    number: readString(source, "number") ?? "",
    status,
    currency: readString(source, "currency") ?? "USD",
    issueDate: readDate(source, "issueDate"),
    dueDate,
    totalCents,
    amountPaidCents,
    balanceDueCents,
    overdue: isOverdue({ status, dueDate }, balanceDueCents, now),
    lineItems: [],
  }
}

/** Detail: totals are recomputed from the line items with the shared helper. */
export function toPortalInvoiceDetail(
  source: PortalSourceRecord,
  lineItemSources: PortalSourceRecord[],
  amountPaidCents: number,
  now = new Date(),
): PortalInvoiceDto {
  const lineItems = lineItemSources.map(toPortalLineItem)
  const status = readString(source, "status") ?? "sent"
  const dueDate = readDate(source, "dueDate")
  const totals = computeInvoiceTotals(
    lineItems,
    // The portal only ever sees the aggregate, never payment rows.
    [{ amountCents: amountPaidCents }],
    { status, dueDate },
    now,
  )
  return {
    id: source.id,
    number: readString(source, "number") ?? "",
    status,
    currency: readString(source, "currency") ?? "USD",
    issueDate: readDate(source, "issueDate"),
    dueDate,
    totalCents: totals.totalCents,
    amountPaidCents: totals.paidCents,
    balanceDueCents: totals.balanceDueCents,
    overdue: totals.overdue,
    lineItems,
  }
}

export type PortalQuoteDto = {
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
  lineItems: PortalLineItemDto[]
}

function quoteMoney(source: PortalSourceRecord) {
  return {
    discountType: readString(source, "discountType") ?? "none",
    discountValue: readNumber(source, "discountValue"),
    taxRateBps: readNumber(source, "taxRateBps"),
  }
}

/**
 * List row: the repository supplies `subtotalCents`, and the discount/tax
 * arithmetic is the quotes module's own `computeQuoteTotals`, fed a single
 * synthetic line item worth the subtotal so the customer-visible grand total
 * always equals the one the CRM shows internally.
 */
export function toPortalQuoteSummary(source: PortalSourceRecord): PortalQuoteDto {
  const subtotalCents = readNumber(source, "subtotalCents")
  const totals = computeQuoteTotals(
    [{ quantity: 1, unitAmountCents: subtotalCents }],
    quoteMoney(source),
  )
  return {
    id: source.id,
    number: readString(source, "number") ?? "",
    status: readString(source, "status") ?? "sent",
    currency: readString(source, "currency") ?? "USD",
    expiresAt: readDate(source, "expiresAt"),
    terms: readString(source, "terms"),
    subtotalCents: totals.subtotalCents,
    discountCents: totals.discountCents,
    taxCents: totals.taxCents,
    grandTotalCents: totals.grandTotalCents,
    lineItems: [],
  }
}

export function toPortalQuoteDetail(
  source: PortalSourceRecord,
  lineItemSources: PortalSourceRecord[],
): PortalQuoteDto {
  const lineItems = lineItemSources.map(toPortalLineItem)
  const totals = computeQuoteTotals(lineItems, quoteMoney(source))
  return {
    ...toPortalQuoteSummary({ ...source, subtotalCents: totals.subtotalCents }),
    subtotalCents: totals.subtotalCents,
    discountCents: totals.discountCents,
    taxCents: totals.taxCents,
    grandTotalCents: totals.grandTotalCents,
    lineItems,
  }
}

export type PortalTicketCommentDto = {
  id: string
  body: string
  authorName: string | null
  authorKind: "customer" | "agent"
  createdAt: string | null
}

export type PortalTicketDto = {
  id: string
  subject: string
  status: string
  priority: string | null
  createdAt: string | null
  updatedAt: string | null
  comments: PortalTicketCommentDto[]
}

/**
 * Comment visibility, fail-closed.
 *
 * The support module is not on this branch, so this cannot be written against
 * its column names. It accepts the two shapes any ticket system uses — a
 * `visibility` string or an `isInternal`/`internal` boolean — and returns
 * FALSE for everything else, including a missing field, a null, a typo'd
 * value and an unexpected type. A comment that cannot prove it is public is
 * internal.
 */
export function isPublicPortalComment(source: PortalSourceRecord): boolean {
  const visibility = source.visibility ?? source.commentVisibility
  if (typeof visibility === "string") return visibility.trim().toLowerCase() === "public"
  const internal = source.isInternal ?? source.internal
  if (typeof internal === "boolean") return !internal
  return false
}

function commentAuthorKind(source: PortalSourceRecord): "customer" | "agent" {
  const kind = source.authorType ?? source.authorKind
  if (typeof kind === "string" && kind.trim().toLowerCase() === "customer") return "customer"
  return "agent"
}

export function toPortalTicketComment(source: PortalSourceRecord): PortalTicketCommentDto {
  return {
    id: source.id,
    body: readString(source, "body", "message", "content") ?? "",
    // Agent *names* are on the customer-facing side of a support reply; agent
    // ids, emails and assignment metadata are not, and are not read here.
    authorName: readString(source, "authorName", "authorDisplayName"),
    authorKind: commentAuthorKind(source),
    createdAt: readDate(source, "createdAt"),
  }
}

export function toPortalTicketSummary(source: PortalSourceRecord): PortalTicketDto {
  return {
    id: source.id,
    subject: readString(source, "subject", "title") ?? "",
    status: readString(source, "status") ?? "open",
    priority: readString(source, "priority"),
    createdAt: readDate(source, "createdAt"),
    updatedAt: readDate(source, "updatedAt"),
    comments: [],
  }
}

/** Detail: summary plus the comments that proved themselves public. */
export function toPortalTicketDetail(
  source: PortalSourceRecord,
  commentSources: PortalSourceRecord[],
): PortalTicketDto {
  return {
    ...toPortalTicketSummary(source),
    comments: commentSources.filter(isPublicPortalComment).map(toPortalTicketComment),
  }
}
