import { createEvent, getEventBus } from "@yourcrm/events"
// `QuoteEvents` is defined in the events envelope but not re-exported from
// the package barrel (centrally owned); import the canonical constant from
// its defining module rather than repeating the strings locally.
import { QuoteEvents } from "@yourcrm/events"
import { requirePermission } from "@yourcrm/permissions"
import { createQuoteSchema, quoteQuerySchema, updateQuoteSchema } from "./schemas"
import type {
  QuoteLineItemRecord,
  QuoteListResult,
  QuoteRecord,
  QuotesServiceContext,
  QuotesServiceDeps,
  QuoteTotals,
  QuoteWithDetails,
} from "./types"

export class QuoteNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`quote ${id} not found`)
    this.name = "QuoteNotFoundError"
  }
}

export class InvalidQuoteTransitionError extends Error {
  readonly code = "INVALID_TRANSITION"
  constructor(message: string) {
    super(message)
    this.name = "InvalidQuoteTransitionError"
  }
}

function permissionOf(ctx: QuotesServiceContext, action: "read" | "create" | "update" | "delete") {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "quote",
    action,
  }
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/**
 * Only `discountType`, `discountValue` and `taxRateBps` are read off a quote
 * here. `QuoteRecord` is a pass-through `Record<string, unknown>`, so none of
 * these keys are statically declared — keeping the index signature in the
 * parameter type is what makes a whole `QuoteRecord` assignable while still
 * naming the fields these helpers use.
 */
export type QuoteMoneyInput = Record<string, unknown> & {
  discountType?: unknown
  discountValue?: unknown
  taxRateBps?: unknown
}

/**
 * Totals are derived from line items and the quote's discount/tax fields —
 * NEVER accepted from the client and never stored as mutable columns.
 * `subtotal = Σ quantity × unitAmountCents`. The discount applies to the
 * subtotal (`percent` is basis points of it, `fixed` is a capped cents
 * amount); tax applies to the post-discount (taxable) amount.
 */
export function computeQuoteTotals(
  lineItems: Pick<QuoteLineItemRecord, "quantity" | "unitAmountCents">[],
  quote: QuoteMoneyInput,
): QuoteTotals {
  const subtotalCents = lineItems.reduce(
    (sum, item) => sum + toNumber(item.quantity) * toNumber(item.unitAmountCents),
    0,
  )
  const discountType = typeof quote.discountType === "string" ? quote.discountType : "none"
  const discountValue = toNumber(quote.discountValue)
  let discountCents = 0
  if (discountType === "percent") {
    discountCents = Math.round((subtotalCents * discountValue) / 10000)
  } else if (discountType === "fixed") {
    discountCents = discountValue
  }
  discountCents = Math.min(Math.max(discountCents, 0), subtotalCents)
  const taxableCents = subtotalCents - discountCents
  const taxRateBps = toNumber(quote.taxRateBps)
  const taxCents = Math.round((taxableCents * taxRateBps) / 10000)
  const grandTotalCents = taxableCents + taxCents
  return { subtotalCents, discountCents, taxCents, grandTotalCents }
}

/** Status lifecycle: draft -> sent -> accepted | rejected. No other edge is valid. */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ["sent"],
  sent: ["accepted", "rejected"],
  accepted: [],
  rejected: [],
}

function assertTransition(from: string, to: string): void {
  const allowed = ALLOWED_TRANSITIONS[from] ?? []
  if (!allowed.includes(to)) {
    throw new InvalidQuoteTransitionError(
      `quote: cannot transition from '${from}' to '${to}' (allowed from '${from}': ${
        allowed.length > 0 ? allowed.join(", ") : "none"
      })`,
    )
  }
}

/**
 * Quotes domain service (mirrors the people reference; line items + money
 * mirror invoices).
 *
 * Every method:
 *  1. calls `requirePermission()` FIRST, before any read or write;
 *  2. does the work through the injected `QuotesStore` port;
 *  3. emits the domain event via the `QuoteEvents` constant (never a literal);
 *  4. writes the audit row with before/after (mutations only).
 */
export function createQuotesService(deps: QuotesServiceDeps) {
  const events = deps.events ?? getEventBus()

  function withTotals(detail: {
    quote: QuoteRecord
    lineItems: QuoteLineItemRecord[]
  }): QuoteWithDetails {
    return { ...detail, totals: computeQuoteTotals(detail.lineItems, detail.quote) }
  }

  async function list(ctx: QuotesServiceContext, rawQuery: unknown): Promise<QuoteListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = quoteQuerySchema.parse(rawQuery)
    return deps.store.list(ctx.workspaceId, query)
  }

  async function get(ctx: QuotesServiceContext, id: string): Promise<QuoteWithDetails> {
    requirePermission(permissionOf(ctx, "read"))
    const found = await deps.store.findWithLineItems(ctx.workspaceId, id)
    if (!found) throw new QuoteNotFoundError(id)
    return withTotals(found)
  }

  async function create(ctx: QuotesServiceContext, rawInput: unknown): Promise<QuoteWithDetails> {
    requirePermission(permissionOf(ctx, "create"))
    // `createQuoteSchema` has no total/grandTotal field, so any client-
    // supplied total is stripped here and never reaches the store.
    const input = createQuoteSchema.parse(rawInput)
    const quote = await deps.store.create(
      ctx.workspaceId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    const detail = await deps.store.findWithLineItems(ctx.workspaceId, quote.id)
    const full: QuoteWithDetails = detail
      ? withTotals(detail)
      : { quote, lineItems: [], totals: computeQuoteTotals([], quote) }
    await events.emit(
      createEvent({
        event: QuoteEvents.Created,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "quote",
        entityId: quote.id,
        after: full.quote,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "quote",
      recordId: quote.id,
      after: full.quote,
      correlationId: ctx.correlationId,
    })
    return full
  }

  async function update(
    ctx: QuotesServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<QuoteRecord> {
    requirePermission(permissionOf(ctx, "update"))
    // `updateQuoteSchema` has no total/grandTotal field either — same
    // guarantee as create: a client-supplied total is dropped by `.parse()`.
    const patch = updateQuoteSchema.parse(rawPatch)
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new QuoteNotFoundError(id)
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new QuoteNotFoundError(id)
    await events.emit(
      createEvent({
        event: QuoteEvents.Updated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "quote",
        entityId: id,
        before,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "quote",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function softDelete(ctx: QuotesServiceContext, id: string): Promise<QuoteRecord> {
    requirePermission(permissionOf(ctx, "delete"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new QuoteNotFoundError(id)
    await deps.store.softDelete(ctx.workspaceId, id, ctx.actorId)
    await events.emit(
      createEvent({
        event: QuoteEvents.Updated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "quote",
        entityId: id,
        before,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "quote",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function restore(ctx: QuotesServiceContext, id: string): Promise<QuoteRecord> {
    requirePermission(permissionOf(ctx, "update"))
    await deps.store.restore(ctx.workspaceId, id)
    const after = await deps.store.findById(ctx.workspaceId, id)
    if (!after) throw new QuoteNotFoundError(id)
    await events.emit(
      createEvent({
        event: QuoteEvents.Updated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "quote",
        entityId: id,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "restore",
      object: "quote",
      recordId: id,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function transition(
    ctx: QuotesServiceContext,
    id: string,
    to: "sent" | "accepted" | "rejected",
    event: string,
  ): Promise<QuoteRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new QuoteNotFoundError(id)
    const from = typeof before.status === "string" ? before.status : "draft"
    assertTransition(from, to)
    const after = await deps.store.update(ctx.workspaceId, id, { status: to }, ctx.actorId)
    if (!after) throw new QuoteNotFoundError(id)
    await events.emit(
      createEvent({
        event,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "quote",
        entityId: id,
        before,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: to,
      object: "quote",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function send(ctx: QuotesServiceContext, id: string): Promise<QuoteRecord> {
    return transition(ctx, id, "sent", QuoteEvents.Sent)
  }

  async function accept(ctx: QuotesServiceContext, id: string): Promise<QuoteRecord> {
    return transition(ctx, id, "accepted", QuoteEvents.Accepted)
  }

  async function reject(ctx: QuotesServiceContext, id: string): Promise<QuoteRecord> {
    return transition(ctx, id, "rejected", QuoteEvents.Rejected)
  }

  return { list, get, create, update, softDelete, restore, send, accept, reject }
}

export type QuotesService = ReturnType<typeof createQuotesService>
