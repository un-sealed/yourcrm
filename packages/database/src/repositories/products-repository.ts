import { and, eq, ilike, isNull, or, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import {
  productPrices,
  products,
  type NewProduct,
  type Product,
  type ProductPrice,
} from "../schema/products"
import { createBaseRepository } from "./base-repository"

export type ProductPriceInput = {
  currency: string
  unitAmount: number | string
}

export type CreateProductInput = {
  sku: string
  name: string
  description?: string | null
  ownerId?: string | null
  isActive?: boolean | null
  prices?: ProductPriceInput[]
}

export type UpdateProductInput = Partial<
  Pick<NewProduct, "sku" | "name" | "description" | "ownerId" | "isActive">
>

export type ProductWithPrices = {
  product: Product
  prices: ProductPrice[]
}

/** Trimmed, non-empty SKU (max 64, mirrors the column). */
export function normalizeProductSku(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new Error("products.create: sku must not be empty")
  if (trimmed.length > 64) throw new Error("products.create: sku must be at most 64 characters")
  return trimmed
}

/** Trimmed, non-empty product name (max 255, mirrors the column). */
export function normalizeProductName(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new Error("products.create: name must not be empty")
  if (trimmed.length > 255) throw new Error("products.create: name must be at most 255 characters")
  return trimmed
}

export function normalizeCurrency(value: string): string {
  const code = value.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new Error("products.create: currency must be a 3-letter ISO code")
  }
  return code
}

export function normalizeAmount(value: number | string): string {
  const amount = typeof value === "string" ? Number(value) : value
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("products.create: unitAmount must be a non-negative number")
  }
  if (amount > 999999999999) {
    throw new Error("products.create: unitAmount is too large")
  }
  return amount.toFixed(2)
}

function toProductValues(
  workspaceId: string,
  input: CreateProductInput | UpdateProductInput,
  actorId?: string,
): Partial<NewProduct> {
  const values: Partial<NewProduct> = {}
  if (input.sku !== undefined) values.sku = normalizeProductSku(input.sku)
  if (input.name !== undefined) values.name = normalizeProductName(input.name)
  if (input.description !== undefined) values.description = input.description ?? null
  if (input.ownerId !== undefined) values.ownerId = input.ownerId
  if (input.isActive !== undefined) values.isActive = input.isActive ?? true
  if (actorId !== undefined) {
    values.updatedBy = actorId
  }
  return { ...values, workspaceId }
}

/**
 * Workspace-scoped products + multi-currency price rows. Prices are
 * full-replacement on update (see `replacePrices`): one live row per
 * (product, currency), enforced by a partial unique index.
 */
export function createProductsRepository() {
  const base = createBaseRepository(products)

  async function insertPrices(
    db: Database,
    workspaceId: string,
    productId: string,
    prices: ProductPriceInput[],
    actorId?: string,
  ): Promise<void> {
    for (const item of prices) {
      await db.insert(productPrices).values({
        workspaceId,
        productId,
        currency: normalizeCurrency(item.currency),
        unitAmount: normalizeAmount(item.unitAmount),
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      })
    }
  }

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateProductInput,
      actorId?: string,
    ): Promise<Product> {
      const rows = await db
        .insert(products)
        .values({
          ...toProductValues(workspaceId, input, actorId),
          workspaceId,
          sku: normalizeProductSku(input.sku),
          name: normalizeProductName(input.name),
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("products.create: insert returned no rows")
      await insertPrices(db, workspaceId, row.id, input.prices ?? [], actorId)
      return row
    },

    /** Cursor-paginated list with optional case-insensitive sku/name search. */
    async search(
      db: Database,
      opts: { workspaceId: string; limit?: number; cursor?: string; order?: "asc" | "desc" } & {
        query?: string
        isActive?: boolean
      },
    ) {
      const conditions: SQL[] = []
      if (opts.query) {
        const q = `%${opts.query.trim()}%`
        const textMatch = or(
          ilike(products.sku, q),
          ilike(products.name, q),
          ilike(products.description, q),
        )
        if (textMatch) conditions.push(textMatch)
      }
      if (opts.isActive !== undefined) {
        conditions.push(eq(products.isActive, opts.isActive))
      }
      const result = await base.list(db, { ...opts, where: conditions })
      return { data: result.data as Product[], pagination: result.pagination }
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateProductInput,
      actorId?: string,
    ): Promise<Product | null> {
      const rows = await db
        .update(products)
        .set({ ...toProductValues(workspaceId, input, actorId), updatedAt: new Date() })
        .where(
          and(
            eq(products.id, id),
            eq(products.workspaceId, workspaceId),
            isNull(products.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    async findById(db: Database, workspaceId: string, id: string): Promise<Product | null> {
      // The shared base narrows rows to the BaseRecord columns; re-select the
      // concrete table here so callers get the full Product shape.
      const row = await base.findById(db, workspaceId, id)
      return (row as Product | null) ?? null
    },

    async findWithPrices(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<ProductWithPrices | null> {
      const product = await this.findById(db, workspaceId, id)
      if (!product) return null
      const prices = await db
        .select()
        .from(productPrices)
        .where(
          and(
            eq(productPrices.productId, id),
            eq(productPrices.workspaceId, workspaceId),
            isNull(productPrices.deletedAt),
          ),
        )
      return { product, prices }
    },

    /** Full price-list replacement: retire live rows, insert the new set. */
    async replacePrices(
      db: Database,
      workspaceId: string,
      productId: string,
      prices: ProductPriceInput[],
      actorId?: string,
    ): Promise<ProductPrice[]> {
      await db
        .update(productPrices)
        .set({ deletedAt: new Date(), ...(actorId === undefined ? {} : { updatedBy: actorId }) })
        .where(
          and(
            eq(productPrices.productId, productId),
            eq(productPrices.workspaceId, workspaceId),
            isNull(productPrices.deletedAt),
          ),
        )
      await insertPrices(db, workspaceId, productId, prices, actorId)
      const rows = await db
        .select()
        .from(productPrices)
        .where(
          and(
            eq(productPrices.productId, productId),
            eq(productPrices.workspaceId, workspaceId),
            isNull(productPrices.deletedAt),
          ),
        )
      return rows
    },
  }
}

export type ProductsRepository = ReturnType<typeof createProductsRepository>
