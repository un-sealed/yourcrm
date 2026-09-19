import { createEvent, getEventBus, ProductEvents } from "@yourcrm/events"
import { requirePermission } from "@yourcrm/permissions"
import { createProductSchema, productQuerySchema, updateProductSchema } from "./schemas"
import type {
  ProductListResult,
  ProductPriceRecord,
  ProductRecord,
  ProductsServiceContext,
  ProductsServiceDeps,
  ProductWithPrices,
} from "./types"

export class ProductNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`product ${id} not found`)
    this.name = "ProductNotFoundError"
  }
}

function permissionOf(
  ctx: ProductsServiceContext,
  action: "read" | "create" | "update" | "delete",
) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "product",
    action,
  }
}

/**
 * Products domain service (mirrors the people service).
 *
 * Every method:
 *  1. calls `requirePermission()` FIRST, before any read or write;
 *  2. does the work through the injected `ProductsStore` port;
 *  3. emits the domain event via the `ProductEvents` constant (never a literal);
 *  4. writes the audit row with before/after (mutations only).
 *
 * Price lists are full-replacement on update: when the patch carries
 * `prices`, the live rows are retired and the new set is inserted.
 */
export function createProductsService(deps: ProductsServiceDeps) {
  const events = deps.events ?? getEventBus()

  async function list(ctx: ProductsServiceContext, rawQuery: unknown): Promise<ProductListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = productQuerySchema.parse(rawQuery)
    return deps.store.list(ctx.workspaceId, {
      limit: query.limit,
      cursor: query.cursor,
      order: query.order,
      query: query.query,
      isActive: query.active === undefined ? undefined : query.active === "true",
    })
  }

  async function get(ctx: ProductsServiceContext, id: string): Promise<ProductWithPrices> {
    requirePermission(permissionOf(ctx, "read"))
    const found = await deps.store.findWithPrices(ctx.workspaceId, id)
    if (!found) throw new ProductNotFoundError(id)
    return found
  }

  async function create(ctx: ProductsServiceContext, rawInput: unknown): Promise<ProductRecord> {
    requirePermission(permissionOf(ctx, "create"))
    const input = createProductSchema.parse(rawInput)
    const product = await deps.store.create(
      ctx.workspaceId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    await events.emit(
      createEvent({
        event: ProductEvents.ProductCreated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "product",
        entityId: product.id,
        after: product,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "product",
      recordId: product.id,
      after: product,
      correlationId: ctx.correlationId,
    })
    return product
  }

  async function update(
    ctx: ProductsServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<ProductRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const patch = updateProductSchema.parse(rawPatch)
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new ProductNotFoundError(id)
    const { prices, ...fields } = patch
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      fields as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new ProductNotFoundError(id)
    let nextPrices: ProductPriceRecord[] | undefined
    if (prices !== undefined) {
      nextPrices = await deps.store.replacePrices(ctx.workspaceId, id, prices, ctx.actorId)
    }
    const afterWithPrices = nextPrices === undefined ? after : { ...after, prices: nextPrices }
    await events.emit(
      createEvent({
        event: ProductEvents.ProductUpdated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "product",
        entityId: id,
        before,
        after: afterWithPrices,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "product",
      recordId: id,
      before,
      after: afterWithPrices,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function softDelete(ctx: ProductsServiceContext, id: string): Promise<ProductRecord> {
    requirePermission(permissionOf(ctx, "delete"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new ProductNotFoundError(id)
    await deps.store.softDelete(ctx.workspaceId, id, ctx.actorId)
    await events.emit(
      createEvent({
        event: ProductEvents.ProductArchived,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "product",
        entityId: id,
        before,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "archive",
      object: "product",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function restore(ctx: ProductsServiceContext, id: string): Promise<ProductRecord> {
    requirePermission(permissionOf(ctx, "update"))
    await deps.store.restore(ctx.workspaceId, id)
    const after = await deps.store.findById(ctx.workspaceId, id)
    if (!after) throw new ProductNotFoundError(id)
    await events.emit(
      createEvent({
        event: ProductEvents.ProductUpdated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "product",
        entityId: id,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "restore",
      object: "product",
      recordId: id,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  return { list, get, create, update, softDelete, restore }
}

export type ProductsService = ReturnType<typeof createProductsService>
