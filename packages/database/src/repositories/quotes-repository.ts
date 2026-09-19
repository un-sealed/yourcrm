import { and, asc, eq, ilike, isNull, or, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import {
  isQuoteDiscountType,
  isQuoteStatus,
  quoteLineItems,
  quotes,
  type NewQuote,
  type Quote,
  type QuoteLineItem,
} from "../schema/quotes"
import { createBaseRepository } from "./base-repository"

export type CreateLineItemInput = {
  description: string
  productId?: string | null
  quantity?: number | null
  unitAmountCents?: number | null
  position?: number | null
}

export type CreateQuoteInput = {
  number: string
  status?: string | null
  currency?: string | null
  expiresAt?: string | null
  companyId?: string | null
  personId?: string | null
  dealId?: string | null
  ownerId?: string | null
  discountType?: string | null
  discountValue?: number | null
  taxRateBps?: number | null
  terms?: string | null
  notes?: string | null
  lineItems?: CreateLineItemInput[]
}

export type UpdateQuoteInput = Partial<
  Pick<
    NewQuote,
    | "number"
    | "currency"
    | "expiresAt"
    | "companyId"
    | "personId"
    | "dealId"
    | "ownerId"
    | "discountValue"
    | "taxRateBps"
    | "terms"
    | "notes"
  >
> & {
  status?: string | null
  discountType?: string | null
}

export type QuoteWithLineItems = {
  quote: Quote
  lineItems: QuoteLineItem[]
}

/** Trimmed, non-empty quote number (max 64, mirrors the column). */
export function normalizeQuoteNumber(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new Error("quotes.create: number must not be empty")
  if (trimmed.length > 64) throw new Error("quotes.create: number must be at most 64 characters")
  return trimmed
}

export function normalizeCurrency(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim() === "") return "USD"
  const trimmed = value.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(trimmed))
    throw new Error("quotes.create: currency must be a 3-letter code")
  return trimmed
}

function normalizeDate(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined || value.trim() === "") return null
  const trimmed = value.trim()
  if (Number.isNaN(Date.parse(trimmed))) {
    throw new Error(`quotes.create: ${field} must be a valid date`)
  }
  return trimmed
}

function normalizeLineItem(item: CreateLineItemInput, position: number) {
  const description = item.description.trim().replace(/\s+/g, " ")
  if (description.length === 0) {
    throw new Error("quotes.create: line item description must not be empty")
  }
  const quantity = item.quantity ?? 1
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error("quotes.create: line item quantity must be a positive integer")
  }
  const unitAmountCents = item.unitAmountCents ?? 0
  if (!Number.isInteger(unitAmountCents) || unitAmountCents < 0) {
    throw new Error("quotes.create: line item unitAmountCents must be a non-negative integer")
  }
  return {
    description,
    productId: item.productId ?? null,
    quantity,
    unitAmountCents,
    position: item.position ?? position,
  }
}

function toQuoteValues(
  workspaceId: string,
  input: CreateQuoteInput | UpdateQuoteInput,
  actorId?: string,
): Partial<NewQuote> {
  const values: Partial<NewQuote> = {}
  if (input.number !== undefined) values.number = normalizeQuoteNumber(input.number)
  if (input.currency !== undefined) values.currency = normalizeCurrency(input.currency)
  if (input.expiresAt !== undefined) values.expiresAt = normalizeDate(input.expiresAt, "expiresAt")
  if (input.companyId !== undefined) values.companyId = input.companyId
  if (input.personId !== undefined) values.personId = input.personId
  if (input.dealId !== undefined) values.dealId = input.dealId
  if (input.ownerId !== undefined) values.ownerId = input.ownerId
  if (input.terms !== undefined) values.terms = input.terms
  if (input.notes !== undefined) values.notes = input.notes
  if (input.discountValue !== undefined) {
    const discountValue = input.discountValue ?? 0
    if (!Number.isInteger(discountValue) || discountValue < 0) {
      throw new Error("quotes.create: discountValue must be a non-negative integer")
    }
    values.discountValue = discountValue
  }
  if (input.taxRateBps !== undefined) {
    const taxRateBps = input.taxRateBps ?? 0
    if (!Number.isInteger(taxRateBps) || taxRateBps < 0) {
      throw new Error("quotes.create: taxRateBps must be a non-negative integer")
    }
    values.taxRateBps = taxRateBps
  }
  if (input.discountType !== undefined) {
    if (input.discountType !== null && !isQuoteDiscountType(input.discountType)) {
      throw new Error("quotes.create: discountType must be one of none, percent, fixed")
    }
    values.discountType = input.discountType ?? "none"
  }
  if (input.status !== undefined) {
    if (input.status !== null && !isQuoteStatus(input.status)) {
      throw new Error("quotes.create: status must be one of draft, sent, accepted, rejected")
    }
    values.status = input.status ?? "draft"
  }
  if (actorId !== undefined) {
    values.updatedBy = actorId
  }
  return { ...values, workspaceId }
}

/**
 * Workspace-scoped quotes + line items. Cross-module references
 * (companyId / personId / dealId / productId) stay plain columns with no
 * joins until the owning modules land; totals are derived by the domain
 * service from line items + discount/tax fields, never stored.
 */
export function createQuotesRepository() {
  const base = createBaseRepository(quotes)

  async function insertLineItems(
    db: Database,
    workspaceId: string,
    quoteId: string,
    items: CreateLineItemInput[],
    actorId?: string,
  ): Promise<void> {
    let position = 0
    for (const item of items) {
      const normalized = normalizeLineItem(item, position)
      position += 1
      await db.insert(quoteLineItems).values({
        workspaceId,
        quoteId,
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
      input: CreateQuoteInput,
      actorId?: string,
    ): Promise<Quote> {
      const rows = await db
        .insert(quotes)
        .values({
          ...toQuoteValues(workspaceId, input, actorId),
          workspaceId,
          number: normalizeQuoteNumber(input.number),
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("quotes.create: insert returned no rows")
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
        const match = or(ilike(quotes.number, q), ilike(quotes.notes, q))
        if (match) conditions.push(match)
      }
      if (opts.status) {
        if (!isQuoteStatus(opts.status)) throw new Error("quotes.search: unknown status filter")
        conditions.push(eq(quotes.status, opts.status))
      }
      const result = await base.list(db, { ...opts, where: conditions })
      return { data: result.data as Quote[], pagination: result.pagination }
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateQuoteInput,
      actorId?: string,
    ): Promise<Quote | null> {
      const rows = await db
        .update(quotes)
        .set({ ...toQuoteValues(workspaceId, input, actorId), updatedAt: new Date() })
        .where(
          and(eq(quotes.id, id), eq(quotes.workspaceId, workspaceId), isNull(quotes.deletedAt)),
        )
        .returning()
      return rows[0] ?? null
    },

    async findById(db: Database, workspaceId: string, id: string): Promise<Quote | null> {
      // The shared base narrows rows to the BaseRecord columns; re-select the
      // concrete table here so callers get the full Quote shape.
      const row = await base.findById(db, workspaceId, id)
      return (row as Quote | null) ?? null
    },

    async findWithLineItems(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<QuoteWithLineItems | null> {
      const quote = await this.findById(db, workspaceId, id)
      if (!quote) return null
      const lineItems = await db
        .select()
        .from(quoteLineItems)
        .where(
          and(
            eq(quoteLineItems.quoteId, id),
            eq(quoteLineItems.workspaceId, workspaceId),
            isNull(quoteLineItems.deletedAt),
          ),
        )
        .orderBy(asc(quoteLineItems.position))
      return { quote, lineItems }
    },
  }
}

export type QuotesRepository = ReturnType<typeof createQuotesRepository>
