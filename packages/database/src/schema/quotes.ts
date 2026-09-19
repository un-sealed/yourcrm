import { isNull } from "drizzle-orm"
import {
  date,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { baseColumns, ownerColumn, workspaceColumn } from "./base"

/**
 * Quotes & Proposals module tables (spec 19-quotes, P0).
 *
 * - `quotes`: one row per quote. `company_id`, `person_id` and `deal_id`
 *   are PLAIN uuid columns with indexes and NO foreign keys — companies,
 *   people and deals are owned by other module agents (same rule as
 *   people.company_id / invoices.quote_id).
 * - `quote_line_items`: line items per quote (FK cascade, owned here).
 *   `product_id` is a PLAIN uuid column with an index and NO foreign key —
 *   products is owned by another module.
 *
 * Money is stored as integer minor units (`*_cents`) so totals stay exact.
 * Discount/tax rates are stored as integer basis points (`*_bps`, 10000 =
 * 100%) for the same reason. `subtotal`/`discount`/`tax`/`grandTotal` are
 * DERIVED (never stored as mutable fields) — see `computeTotals` in the
 * domain service, which recomputes them server-side on every read and
 * ignores any total the client supplies.
 */

export const QUOTE_STATUSES = ["draft", "sent", "accepted", "rejected"] as const

export type QuoteStatus = (typeof QUOTE_STATUSES)[number]

export function isQuoteStatus(value: unknown): value is QuoteStatus {
  return typeof value === "string" && (QUOTE_STATUSES as readonly string[]).includes(value)
}

export const QUOTE_DISCOUNT_TYPES = ["none", "percent", "fixed"] as const

export type QuoteDiscountType = (typeof QUOTE_DISCOUNT_TYPES)[number]

export function isQuoteDiscountType(value: unknown): value is QuoteDiscountType {
  return typeof value === "string" && (QUOTE_DISCOUNT_TYPES as readonly string[]).includes(value)
}

export const quotes = pgTable(
  "quotes",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    number: varchar("number", { length: 64 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("draft"),
    currency: varchar("currency", { length: 8 }).notNull().default("USD"),
    expiresAt: date("expires_at"),
    // Cross-module references (plain uuid, NO foreign key — see header).
    companyId: uuid("company_id"),
    personId: uuid("person_id"),
    dealId: uuid("deal_id"),
    // Discount: "none" | "percent" (discountValue is bps) | "fixed"
    // (discountValue is cents), applied to the line-item subtotal.
    discountType: varchar("discount_type", { length: 16 }).notNull().default("none"),
    discountValue: integer("discount_value").notNull().default(0),
    // Tax rate in basis points (10000 = 100%), applied after the discount.
    taxRateBps: integer("tax_rate_bps").notNull().default(0),
    terms: text("terms"),
    notes: text("notes"),
  },
  (t) => [
    index("quotes_workspace_idx").on(t.workspaceId),
    uniqueIndex("quotes_workspace_number_uidx")
      .on(t.workspaceId, t.number)
      .where(isNull(t.deletedAt)),
    index("quotes_status_idx").on(t.workspaceId, t.status),
    index("quotes_company_idx").on(t.companyId),
    index("quotes_person_idx").on(t.personId),
    index("quotes_deal_idx").on(t.dealId),
    index("quotes_expires_at_idx").on(t.workspaceId, t.expiresAt),
  ],
)

export type Quote = typeof quotes.$inferSelect
export type NewQuote = typeof quotes.$inferInsert

export const quoteLineItems = pgTable(
  "quote_line_items",
  {
    ...baseColumns,
    ...workspaceColumn,
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quotes.id, { onDelete: "cascade" }),
    // Cross-module reference (plain uuid, NO foreign key — see header).
    productId: uuid("product_id"),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull().default(1),
    unitAmountCents: integer("unit_amount_cents").notNull().default(0),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    index("quote_line_items_quote_idx").on(t.quoteId),
    index("quote_line_items_workspace_idx").on(t.workspaceId),
    index("quote_line_items_product_idx").on(t.productId),
  ],
)

export type QuoteLineItem = typeof quoteLineItems.$inferSelect
export type NewQuoteLineItem = typeof quoteLineItems.$inferInsert
