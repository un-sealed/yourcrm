import type { FilterFieldDef, FilterTree } from "@yourcrm/ui"

/** Quote record as returned by `GET /api/v1/quotes` (envelope `data` item). */
export type Quote = {
  id: string
  workspaceId: string
  number: string
  status: string
  currency: string
  expiresAt: string | null
  companyId: string | null
  personId: string | null
  dealId: string | null
  ownerId: string | null
  discountType: string
  discountValue: number
  taxRateBps: number
  terms: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
}

export type QuoteLineItem = {
  id: string
  description: string
  productId: string | null
  quantity: number
  unitAmountCents: number
  position: number
}

/** Server-computed only — never editable, never sent by the client. */
export type QuoteTotals = {
  subtotalCents: number
  discountCents: number
  taxCents: number
  grandTotalCents: number
}

export type QuoteDetail = Quote & {
  lineItems: QuoteLineItem[]
  totals: QuoteTotals
}

export type QuotesListResponse = {
  data: Quote[]
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

export function statusTone(status: string): "success" | "warning" | "secondary" | "destructive" {
  if (status === "accepted") return "success"
  if (status === "rejected") return "destructive"
  if (status === "sent") return "warning"
  return "secondary"
}

export const QUOTE_FILTER_FIELDS: FilterFieldDef[] = [
  { name: "number", label: "Number", type: "text" },
  { name: "notes", label: "Notes", type: "text" },
  {
    name: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "draft", label: "Draft" },
      { value: "sent", label: "Sent" },
      { value: "accepted", label: "Accepted" },
      { value: "rejected", label: "Rejected" },
    ],
  },
]

export type { FilterTree }
