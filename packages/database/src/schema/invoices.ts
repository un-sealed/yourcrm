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
 * Invoices & Payments module tables (spec 20-invoices-payments, P0).
 *
 * - `invoices`: one row per invoice. `company_id`, `person_id` and
 *   `quote_id` are PLAIN uuid columns with indexes and NO foreign keys —
 *   the companies/people/quotes tables are owned by other module agents
 *   (same rule as people.company_id).
 * - `invoice_line_items`: line items per invoice (FK cascade, owned here).
 * - `payments`: manually recorded payments per invoice (FK cascade, owned
 *   here). No payment-gateway integration in P0.
 *
 * Money is stored as integer minor units (`*_cents`) so totals stay exact.
 * `balance_due` is DERIVED (line-item total minus recorded payments) and is
 * never stored as a mutable field — see `computeTotals` in the domain
 * service. Overdue is derived from `due_date` the same way.
 */

export const INVOICE_STATUSES = ["draft", "sent", "paid", "void"] as const

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

export function isInvoiceStatus(value: unknown): value is InvoiceStatus {
  return typeof value === "string" && (INVOICE_STATUSES as readonly string[]).includes(value)
}

export const PAYMENT_METHODS = ["cash", "card", "bank_transfer", "upi", "other"] as const

export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === "string" && (PAYMENT_METHODS as readonly string[]).includes(value)
}

export const invoices = pgTable(
  "invoices",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    number: varchar("number", { length: 64 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("draft"),
    currency: varchar("currency", { length: 8 }).notNull().default("USD"),
    issueDate: date("issue_date"),
    dueDate: date("due_date"),
    // Cross-module references (plain uuid, NO foreign key — see header).
    companyId: uuid("company_id"),
    personId: uuid("person_id"),
    quoteId: uuid("quote_id"),
    notes: text("notes"),
  },
  (t) => [
    index("invoices_workspace_idx").on(t.workspaceId),
    uniqueIndex("invoices_workspace_number_uidx")
      .on(t.workspaceId, t.number)
      .where(isNull(t.deletedAt)),
    index("invoices_status_idx").on(t.workspaceId, t.status),
    index("invoices_company_idx").on(t.companyId),
    index("invoices_person_idx").on(t.personId),
    index("invoices_quote_idx").on(t.quoteId),
    index("invoices_due_date_idx").on(t.workspaceId, t.dueDate),
  ],
)

export type Invoice = typeof invoices.$inferSelect
export type NewInvoice = typeof invoices.$inferInsert

export const invoiceLineItems = pgTable(
  "invoice_line_items",
  {
    ...baseColumns,
    ...workspaceColumn,
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull().default(1),
    unitAmountCents: integer("unit_amount_cents").notNull().default(0),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    index("invoice_line_items_invoice_idx").on(t.invoiceId),
    index("invoice_line_items_workspace_idx").on(t.workspaceId),
  ],
)

export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect
export type NewInvoiceLineItem = typeof invoiceLineItems.$inferInsert

export const payments = pgTable(
  "payments",
  {
    ...baseColumns,
    ...workspaceColumn,
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    amountCents: integer("amount_cents").notNull(),
    currency: varchar("currency", { length: 8 }).notNull().default("USD"),
    method: varchar("method", { length: 32 }).notNull().default("other"),
    paidAt: date("paid_at"),
    reference: varchar("reference", { length: 255 }),
    notes: text("notes"),
  },
  (t) => [
    index("payments_invoice_idx").on(t.invoiceId),
    index("payments_workspace_idx").on(t.workspaceId),
  ],
)

export type Payment = typeof payments.$inferSelect
export type NewPayment = typeof payments.$inferInsert
