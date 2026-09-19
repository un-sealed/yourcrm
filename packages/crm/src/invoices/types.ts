import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"

/**
 * Invoices service ports (mirrors the people module pattern).
 *
 * `@yourcrm/crm` has no database dependency, so the service never imports
 * `@yourcrm/database`. It depends on these structural ports instead; the API
 * layer adapts the drizzle repository (`invoices-repository.ts`) and
 * `writeAudit` to them. Any object with matching methods satisfies the
 * port — including the `createStore` fake in hermetic tests.
 */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type InvoiceRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
}

export type InvoiceLineItemRecord = Record<string, unknown> & {
  id: string
  invoiceId: string
  quantity: number
  unitAmountCents: number
}

export type PaymentRecord = Record<string, unknown> & {
  id: string
  invoiceId: string
  amountCents: number
}

export type InvoiceTotals = {
  totalCents: number
  paidCents: number
  balanceDueCents: number
  overdue: boolean
}

export type InvoiceWithDetails = {
  invoice: InvoiceRecord
  lineItems: InvoiceLineItemRecord[]
  payments: PaymentRecord[]
  totals: InvoiceTotals
}

export type InvoiceListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
  status?: string
}

export type InvoiceListResult = {
  data: InvoiceRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type InvoiceDetailQuery = {
  invoice: InvoiceRecord
  lineItems: InvoiceLineItemRecord[]
  payments: PaymentRecord[]
}

export type InvoicesStore = {
  list(workspaceId: string, query: InvoiceListQuery): Promise<InvoiceListResult>
  findById(workspaceId: string, id: string): Promise<InvoiceRecord | null>
  findWithDetails(workspaceId: string, id: string): Promise<InvoiceDetailQuery | null>
  create(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<InvoiceRecord>
  update(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<InvoiceRecord | null>
  recordPayment(
    workspaceId: string,
    invoiceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<PaymentRecord>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  restore(workspaceId: string, id: string): Promise<void>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type InvoiceAuditInput = {
  workspaceId: string
  actorId?: string | null
  action: string
  object: string
  recordId?: string | null
  before?: unknown
  after?: unknown
  correlationId?: string | null
  source?: "user" | "automation" | "ai" | "integration" | "mcp"
}

export type InvoicesServiceContext = ServiceContext

export type InvoicesServiceDeps = {
  store: InvoicesStore
  audit: AuditWriter<InvoiceAuditInput>
  events?: EventEmitter
}
