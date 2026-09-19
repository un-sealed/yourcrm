import { createEvent, getEventBus } from "@yourcrm/events"
// `InvoiceEvents` is defined in the events envelope but not re-exported from
// the package barrel (centrally owned); import the canonical constant from
// its defining module rather than repeating the strings locally.
import { InvoiceEvents } from "@yourcrm/events/src/envelope"
import { requirePermission } from "@yourcrm/permissions"
import {
  createInvoiceSchema,
  invoiceQuerySchema,
  recordPaymentSchema,
  updateInvoiceSchema,
} from "./schemas"
import type {
  InvoiceLineItemRecord,
  InvoiceListResult,
  InvoiceRecord,
  InvoicesServiceContext,
  InvoicesServiceDeps,
  InvoiceTotals,
  InvoiceWithDetails,
  PaymentRecord,
} from "./types"

export class InvoiceNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`invoice ${id} not found`)
    this.name = "InvoiceNotFoundError"
  }
}

function permissionOf(
  ctx: InvoicesServiceContext,
  action: "read" | "create" | "update" | "delete",
) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "invoice",
    action,
  }
}

function toCents(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/**
 * Balance due is derived from line items and recorded payments — it is never
 * stored as a mutable field. `total = Σ quantity × unitAmountCents`,
 * `paid = Σ payment amountCents`, `balanceDue = total − paid`.
 */
export function computeTotals(
  lineItems: Pick<InvoiceLineItemRecord, "quantity" | "unitAmountCents">[],
  payments: Pick<PaymentRecord, "amountCents">[],
  invoice: Pick<InvoiceRecord, "status"> & { dueDate?: unknown },
  now: Date = new Date(),
): InvoiceTotals {
  const totalCents = lineItems.reduce(
    (sum, item) => sum + toCents(item.quantity) * toCents(item.unitAmountCents),
    0,
  )
  const paidCents = payments.reduce((sum, payment) => sum + toCents(payment.amountCents), 0)
  const balanceDueCents = totalCents - paidCents
  return { totalCents, paidCents, balanceDueCents, overdue: isOverdue(invoice, balanceDueCents, now) }
}

/** Overdue when unpaid, past its due date, and not closed (paid/void). */
export function isOverdue(
  invoice: Pick<InvoiceRecord, "status"> & { dueDate?: unknown },
  balanceDueCents: number,
  now: Date = new Date(),
): boolean {
  if (invoice.status === "paid" || invoice.status === "void") return false
  if (balanceDueCents <= 0) return false
  if (typeof invoice.dueDate !== "string" || invoice.dueDate.trim() === "") return false
  const due = Date.parse(invoice.dueDate)
  if (Number.isNaN(due)) return false
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  return due < today.getTime()
}

/**
 * Invoices domain service (mirrors the people reference).
 *
 * Every method:
 *  1. calls `requirePermission()` FIRST, before any read or write;
 *  2. does the work through the injected `InvoicesStore` port;
 *  3. emits the domain event via the `InvoiceEvents` constant (never a literal);
 *  4. writes the audit row with before/after (mutations only).
 */
export function createInvoicesService(deps: InvoicesServiceDeps) {
  const events = deps.events ?? getEventBus()

  function withTotals(detail: {
    invoice: InvoiceRecord
    lineItems: InvoiceLineItemRecord[]
    payments: PaymentRecord[]
  }): InvoiceWithDetails {
    return { ...detail, totals: computeTotals(detail.lineItems, detail.payments, detail.invoice) }
  }

  async function list(ctx: InvoicesServiceContext, rawQuery: unknown): Promise<InvoiceListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = invoiceQuerySchema.parse(rawQuery)
    return deps.store.list(ctx.workspaceId, query)
  }

  async function get(ctx: InvoicesServiceContext, id: string): Promise<InvoiceWithDetails> {
    requirePermission(permissionOf(ctx, "read"))
    const found = await deps.store.findWithDetails(ctx.workspaceId, id)
    if (!found) throw new InvoiceNotFoundError(id)
    return withTotals(found)
  }

  async function create(ctx: InvoicesServiceContext, rawInput: unknown): Promise<InvoiceWithDetails> {
    requirePermission(permissionOf(ctx, "create"))
    const input = createInvoiceSchema.parse(rawInput)
    const invoice = await deps.store.create(
      ctx.workspaceId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    const detail = await deps.store.findWithDetails(ctx.workspaceId, invoice.id)
    const full: InvoiceWithDetails = detail
      ? withTotals(detail)
      : { invoice, lineItems: [], payments: [], totals: computeTotals([], [], invoice) }
    await events.emit(
      createEvent({
        event: InvoiceEvents.Created,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "invoice",
        entityId: invoice.id,
        after: full.invoice,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "invoice",
      recordId: invoice.id,
      after: full.invoice,
      correlationId: ctx.correlationId,
    })
    return full
  }

  async function update(
    ctx: InvoicesServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<InvoiceRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const patch = updateInvoiceSchema.parse(rawPatch)
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new InvoiceNotFoundError(id)
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new InvoiceNotFoundError(id)
    await events.emit(
      createEvent({
        event: InvoiceEvents.Updated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "invoice",
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
      object: "invoice",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function softDelete(ctx: InvoicesServiceContext, id: string): Promise<InvoiceRecord> {
    requirePermission(permissionOf(ctx, "delete"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new InvoiceNotFoundError(id)
    await deps.store.softDelete(ctx.workspaceId, id, ctx.actorId)
    await events.emit(
      createEvent({
        event: InvoiceEvents.Updated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "invoice",
        entityId: id,
        before,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "invoice",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function restore(ctx: InvoicesServiceContext, id: string): Promise<InvoiceRecord> {
    requirePermission(permissionOf(ctx, "update"))
    await deps.store.restore(ctx.workspaceId, id)
    const after = await deps.store.findById(ctx.workspaceId, id)
    if (!after) throw new InvoiceNotFoundError(id)
    await events.emit(
      createEvent({
        event: InvoiceEvents.Updated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "invoice",
        entityId: id,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "restore",
      object: "invoice",
      recordId: id,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function send(ctx: InvoicesServiceContext, id: string): Promise<InvoiceRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new InvoiceNotFoundError(id)
    if (before.status !== "draft") {
      throw new Error(`invoice.send: only draft invoices can be sent (status is ${before.status})`)
    }
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      { status: "sent" },
      ctx.actorId,
    )
    if (!after) throw new InvoiceNotFoundError(id)
    await events.emit(
      createEvent({
        event: InvoiceEvents.Sent,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "invoice",
        entityId: id,
        before,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "send",
      object: "invoice",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function recordPayment(
    ctx: InvoicesServiceContext,
    id: string,
    rawPayment: unknown,
  ): Promise<InvoiceWithDetails> {
    requirePermission(permissionOf(ctx, "create"))
    const payment = recordPaymentSchema.parse(rawPayment)
    const detail = await deps.store.findWithDetails(ctx.workspaceId, id)
    if (!detail) throw new InvoiceNotFoundError(id)
    const created = await deps.store.recordPayment(
      ctx.workspaceId,
      id,
      payment as Record<string, unknown>,
      ctx.actorId,
    )
    await events.emit(
      createEvent({
        event: InvoiceEvents.PaymentRecorded,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "payment",
        entityId: created.id,
        after: created,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "payment",
      object: "invoice",
      recordId: id,
      before: detail.invoice,
      after: created,
      correlationId: ctx.correlationId,
    })
    const refreshed = await deps.store.findWithDetails(ctx.workspaceId, id)
    if (!refreshed) throw new InvoiceNotFoundError(id)
    const full = withTotals(refreshed)
    if (full.totals.balanceDueCents <= 0 && full.invoice.status !== "paid") {
      const before = full.invoice
      const after = await deps.store.update(
        ctx.workspaceId,
        id,
        { status: "paid" },
        ctx.actorId,
      )
      if (!after) throw new InvoiceNotFoundError(id)
      await events.emit(
        createEvent({
          event: InvoiceEvents.Paid,
          workspaceId: ctx.workspaceId,
          actorId: ctx.actorId,
          entityType: "invoice",
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
        object: "invoice",
        recordId: id,
        before,
        after,
        correlationId: ctx.correlationId,
      })
      return { ...full, invoice: after }
    }
    return full
  }

  return { list, get, create, update, softDelete, restore, send, recordPayment }
}

export type InvoicesService = ReturnType<typeof createInvoicesService>
