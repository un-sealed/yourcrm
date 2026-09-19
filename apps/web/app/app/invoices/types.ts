import type { FilterFieldDef, FilterTree } from "@yourcrm/ui"

/** Invoice record as returned by `GET /api/v1/invoices` (envelope `data` item). */
export type Invoice = {
  id: string
  workspaceId: string
  number: string
  status: string
  currency: string
  issueDate: string | null
  dueDate: string | null
  companyId: string | null
  personId: string | null
  quoteId: string | null
  ownerId: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
}

export type InvoiceLineItem = {
  id: string
  description: string
  quantity: number
  unitAmountCents: number
  position: number
}

export type InvoicePayment = {
  id: string
  amountCents: number
  currency: string
  method: string
  paidAt: string | null
  reference: string | null
  notes: string | null
}

export type InvoiceTotals = {
  totalCents: number
  paidCents: number
  balanceDueCents: number
  overdue: boolean
}

export type InvoiceDetail = Invoice & {
  lineItems: InvoiceLineItem[]
  payments: InvoicePayment[]
  totals: InvoiceTotals
}

export type InvoicesListResponse = {
  data: Invoice[]
  pagination: { nextCursor: string | null; limit: number }
}

/** Minor-unit money formatting shared by the list and detail pages. */
export function formatMoney(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`
  }
}

export function statusTone(status: string, overdue: boolean): "success" | "warning" | "secondary" | "destructive" {
  if (overdue) return "destructive"
  if (status === "paid") return "success"
  if (status === "sent") return "warning"
  return "secondary"
}

export function statusLabel(status: string, overdue: boolean): string {
  if (overdue) return "overdue"
  return status
}

export const INVOICE_FILTER_FIELDS: FilterFieldDef[] = [
  { name: "number", label: "Number", type: "text" },
  { name: "notes", label: "Notes", type: "text" },
  {
    name: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "draft", label: "Draft" },
      { value: "sent", label: "Sent" },
      { value: "paid", label: "Paid" },
      { value: "void", label: "Void" },
    ],
  },
]

export type { FilterTree }
