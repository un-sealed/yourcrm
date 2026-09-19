import { and, asc, eq, ilike, isNull, or, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import {
  invoiceLineItems,
  invoices,
  isInvoiceStatus,
  isPaymentMethod,
  payments,
  type Invoice,
  type InvoiceLineItem,
  type NewInvoice,
  type Payment,
} from "../schema/invoices"
import { createBaseRepository } from "./base-repository"

export type CreateLineItemInput = {
  description: string
  quantity?: number | null
  unitAmountCents?: number | null
  position?: number | null
}

export type CreateInvoiceInput = {
  number: string
  status?: string | null
  currency?: string | null
  issueDate?: string | null
  dueDate?: string | null
  companyId?: string | null
  personId?: string | null
  quoteId?: string | null
  ownerId?: string | null
  notes?: string | null
  lineItems?: CreateLineItemInput[]
}

export type UpdateInvoiceInput = Partial<
  Pick<
    NewInvoice,
    | "number"
    | "currency"
    | "issueDate"
    | "dueDate"
    | "companyId"
    | "personId"
    | "quoteId"
    | "ownerId"
    | "notes"
  >
> & {
  status?: string | null
}

export type CreatePaymentInput = {
  amountCents: number
  currency?: string | null
  method?: string | null
  paidAt?: string | null
  reference?: string | null
  notes?: string | null
}

export type InvoiceWithDetails = {
  invoice: Invoice
  lineItems: InvoiceLineItem[]
  payments: Payment[]
}

/** Trimmed, non-empty invoice number (max 64, mirrors the column). */
export function normalizeInvoiceNumber(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new Error("invoices.create: number must not be empty")
  if (trimmed.length > 64) throw new Error("invoices.create: number must be at most 64 characters")
  return trimmed
}

export function normalizeCurrency(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim() === "") return "USD"
  const trimmed = value.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(trimmed)) throw new Error("invoices.create: currency must be a 3-letter code")
  return trimmed
}

function normalizeDate(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined || value.trim() === "") return null
  const trimmed = value.trim()
  if (Number.isNaN(Date.parse(trimmed))) {
    throw new Error(`invoices.create: ${field} must be a valid date`)
  }
  return trimmed
}

function normalizeLineItem(item: CreateLineItemInput, position: number) {
  const description = item.description.trim().replace(/\s+/g, " ")
  if (description.length === 0) throw new Error("invoices.create: line item description must not be empty")
  const quantity = item.quantity ?? 1
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error("invoices.create: line item quantity must be a positive integer")
  }
  const unitAmountCents = item.unitAmountCents ?? 0
  if (!Number.isInteger(unitAmountCents) || unitAmountCents < 0) {
    throw new Error("invoices.create: line item unitAmountCents must be a non-negative integer")
  }
  return { description, quantity, unitAmountCents, position: item.position ?? position }
}

function toInvoiceValues(
  workspaceId: string,
  input: CreateInvoiceInput | UpdateInvoiceInput,
  actorId?: string,
): Partial<NewInvoice> {
  const values: Partial<NewInvoice> = {}
  if (input.number !== undefined) values.number = normalizeInvoiceNumber(input.number)
  if (input.currency !== undefined) values.currency = normalizeCurrency(input.currency)
  if (input.issueDate !== undefined) values.issueDate = normalizeDate(input.issueDate, "issueDate")
  if (input.dueDate !== undefined) values.dueDate = normalizeDate(input.dueDate, "dueDate")
  if (input.companyId !== undefined) values.companyId = input.companyId
  if (input.personId !== undefined) values.personId = input.personId
  if (input.quoteId !== undefined) values.quoteId = input.quoteId
  if (input.ownerId !== undefined) values.ownerId = input.ownerId
  if (input.notes !== undefined) values.notes = input.notes
  if (input.status !== undefined) {
    if (input.status !== null && !isInvoiceStatus(input.status)) {
      throw new Error("invoices.create: status must be one of draft, sent, paid, void")
    }
    values.status = input.status ?? "draft"
  }
  if (actorId !== undefined) {
    values.updatedBy = actorId
  }
  return { ...values, workspaceId }
}

/**
 * Workspace-scoped invoices + line items + payments. Cross-module references
 * (companyId / personId / quoteId) stay plain columns with no joins until
 * the owning modules land; the balance due is derived by the domain service
 * from line items and payments, never stored.
 */
export function createInvoicesRepository() {
  const base = createBaseRepository(invoices)

  async function insertLineItems(
    db: Database,
    workspaceId: string,
    invoiceId: string,
    items: CreateLineItemInput[],
    actorId?: string,
  ): Promise<void> {
    let position = 0
    for (const item of items) {
      const normalized = normalizeLineItem(item, position)
      position += 1
      await db.insert(invoiceLineItems).values({
        workspaceId,
        invoiceId,
        ...normalized,
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      })
    }
  }

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateInvoiceInput,
      actorId?: string,
    ): Promise<Invoice> {
      const rows = await db
        .insert(invoices)
        .values({
          ...toInvoiceValues(workspaceId, input, actorId),
          workspaceId,
          number: normalizeInvoiceNumber(input.number),
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("invoices.create: insert returned no rows")
      await insertLineItems(db, workspaceId, row.id, input.lineItems ?? [], actorId)
      return row
    },

    /** Cursor-paginated list with optional number/notes search + status filter. */
    async search(
      db: Database,
      opts: { workspaceId: string; limit?: number; cursor?: string; order?: "asc" | "desc" } & {
        query?: string
        status?: string
      },
    ) {
      const conditions: SQL[] = []
      if (opts.query) {
        const q = `%${opts.query.trim()}%`
        const match = or(ilike(invoices.number, q), ilike(invoices.notes, q))
        if (match) conditions.push(match)
      }
      if (opts.status) {
        if (!isInvoiceStatus(opts.status)) throw new Error("invoices.search: unknown status filter")
        conditions.push(eq(invoices.status, opts.status))
      }
      const result = await base.list(db, { ...opts, where: conditions })
      return { data: result.data as Invoice[], pagination: result.pagination }
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateInvoiceInput,
      actorId?: string,
    ): Promise<Invoice | null> {
      const rows = await db
        .update(invoices)
        .set({ ...toInvoiceValues(workspaceId, input, actorId), updatedAt: new Date() })
        .where(
          and(eq(invoices.id, id), eq(invoices.workspaceId, workspaceId), isNull(invoices.deletedAt)),
        )
        .returning()
      return rows[0] ?? null
    },

    async findById(db: Database, workspaceId: string, id: string): Promise<Invoice | null> {
      // The shared base narrows rows to the BaseRecord columns; re-select the
      // concrete table here so callers get the full Invoice shape.
      const row = await base.findById(db, workspaceId, id)
      return (row as Invoice | null) ?? null
    },

    async findWithDetails(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<InvoiceWithDetails | null> {
      const invoice = await this.findById(db, workspaceId, id)
      if (!invoice) return null
      const lineItems = await db
        .select()
        .from(invoiceLineItems)
        .where(
          and(
            eq(invoiceLineItems.invoiceId, id),
            eq(invoiceLineItems.workspaceId, workspaceId),
            isNull(invoiceLineItems.deletedAt),
          ),
        )
        .orderBy(asc(invoiceLineItems.position))
      const paymentRows = await db
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.invoiceId, id),
            eq(payments.workspaceId, workspaceId),
            isNull(payments.deletedAt),
          ),
        )
      return { invoice, lineItems, payments: paymentRows }
    },

    async recordPayment(
      db: Database,
      workspaceId: string,
      invoiceId: string,
      input: CreatePaymentInput,
      actorId?: string,
    ): Promise<Payment> {
      if (!Number.isInteger(input.amountCents) || input.amountCents < 1) {
        throw new Error("invoices.recordPayment: amountCents must be a positive integer")
      }
      const method = input.method ?? "other"
      if (!isPaymentMethod(method)) {
        throw new Error("invoices.recordPayment: method must be one of cash, card, bank_transfer, upi, other")
      }
      const rows = await db
        .insert(payments)
        .values({
          workspaceId,
          invoiceId,
          amountCents: input.amountCents,
          currency: normalizeCurrency(input.currency ?? undefined),
          method,
          paidAt: normalizeDate(input.paidAt ?? undefined, "paidAt"),
          reference: input.reference?.trim() || null,
          notes: input.notes ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("invoices.recordPayment: insert returned no rows")
      return row
    },
  }
}

export type InvoicesRepository = ReturnType<typeof createInvoicesRepository>
