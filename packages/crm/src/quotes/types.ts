import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"

/**
 * Quotes service ports (mirrors the people module pattern).
 *
 * `@yourcrm/crm` has no database dependency, so the service never imports
 * `@yourcrm/database`. It depends on these structural ports instead; the API
 * layer adapts the drizzle repository (`quotes-repository.ts`) and
 * `writeAudit` to them. Any object with matching methods satisfies the
 * port — including the `createStore` fake in hermetic tests.
 */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type QuoteRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
}

export type QuoteLineItemRecord = Record<string, unknown> & {
  id: string
  quoteId: string
  quantity: number
  unitAmountCents: number
}

export type QuoteTotals = {
  subtotalCents: number
  discountCents: number
  taxCents: number
  grandTotalCents: number
}

export type QuoteWithDetails = {
  quote: QuoteRecord
  lineItems: QuoteLineItemRecord[]
  totals: QuoteTotals
}

export type QuoteListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
  status?: string
}

export type QuoteListResult = {
  data: QuoteRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type QuoteDetailQuery = {
  quote: QuoteRecord
  lineItems: QuoteLineItemRecord[]
}

export type QuotesStore = {
  list(workspaceId: string, query: QuoteListQuery): Promise<QuoteListResult>
  findById(workspaceId: string, id: string): Promise<QuoteRecord | null>
  findWithLineItems(workspaceId: string, id: string): Promise<QuoteDetailQuery | null>
  create(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<QuoteRecord>
  update(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<QuoteRecord | null>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  restore(workspaceId: string, id: string): Promise<void>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type QuoteAuditInput = {
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

export type QuotesServiceContext = ServiceContext

export type QuotesServiceDeps = {
  store: QuotesStore
  audit: AuditWriter<QuoteAuditInput>
  events?: EventEmitter
}
