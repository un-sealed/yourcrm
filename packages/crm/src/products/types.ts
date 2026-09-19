import type { ServiceContext } from "../index"

/**
 * Products service ports (mirrors the people module pattern).
 *
 * `@yourcrm/crm` has no database dependency, so the service never imports
 * `@yourcrm/database`. It depends on these structural ports instead; the API
 * layer adapts the drizzle repository (`products-repository.ts`) and
 * `writeAudit` to them. Any object with matching methods satisfies the
 * port — including the `createStore` fake in hermetic tests.
 */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type ProductRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
}

export type ProductPriceRecord = Record<string, unknown> & {
  id: string
  productId: string
}

export type ProductWithPrices = {
  product: ProductRecord
  prices: ProductPriceRecord[]
}

export type ProductListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
  isActive?: boolean
}

export type ProductListResult = {
  data: ProductRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type ProductsStore = {
  list(workspaceId: string, query: ProductListQuery): Promise<ProductListResult>
  findById(workspaceId: string, id: string): Promise<ProductRecord | null>
  findWithPrices(workspaceId: string, id: string): Promise<ProductWithPrices | null>
  create(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<ProductRecord>
  update(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<ProductRecord | null>
  replacePrices(
    workspaceId: string,
    id: string,
    prices: { currency: string; unitAmount: number }[],
    actorId?: string,
  ): Promise<ProductPriceRecord[]>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  restore(workspaceId: string, id: string): Promise<void>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type ProductAuditInput = {
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

export type AuditWriter = (input: ProductAuditInput) => Promise<unknown>

export type EventEmitter = {
  emit(event: {
    event: string
    workspaceId: string
    actorId?: string
    entityType?: string
    entityId?: string
    before?: unknown
    after?: unknown
    correlationId?: string
  }): Promise<void>
}

export type ProductsServiceContext = ServiceContext

export type ProductsServiceDeps = {
  store: ProductsStore
  audit: AuditWriter
  events?: EventEmitter
}
