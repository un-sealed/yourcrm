import { isNull, sql } from "drizzle-orm"
import {
  boolean,
  index,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { baseColumns, ownerColumn, workspaceColumn } from "./base"

/**
 * Products module tables (spec 18-products, P0).
 *
 * - `products`: one row per catalog product/service. SKU is unique per
 *   workspace (case-insensitive, live rows only).
 * - `product_prices`: multi-currency price list rows, one live row per
 *   (product, currency). Currency is stored uppercase (ISO 4217).
 */

export const products = pgTable(
  "products",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    sku: varchar("sku", { length: 64 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [
    index("products_workspace_idx").on(t.workspaceId),
    index("products_active_idx").on(t.workspaceId, t.isActive),
    index("products_name_idx").on(t.workspaceId, sql`lower(${t.name})`),
    uniqueIndex("products_workspace_sku_uidx")
      .on(t.workspaceId, sql`lower(${t.sku})`)
      .where(isNull(t.deletedAt)),
  ],
)

export type Product = typeof products.$inferSelect
export type NewProduct = typeof products.$inferInsert

export const productPrices = pgTable(
  "product_prices",
  {
    ...baseColumns,
    ...workspaceColumn,
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    currency: varchar("currency", { length: 3 }).notNull(),
    unitAmount: numeric("unit_amount", { precision: 14, scale: 2 }).notNull(),
  },
  (t) => [
    index("product_prices_product_idx").on(t.productId),
    uniqueIndex("product_prices_product_currency_uidx")
      .on(t.productId, t.currency)
      .where(isNull(t.deletedAt)),
  ],
)

export type ProductPrice = typeof productPrices.$inferSelect
export type NewProductPrice = typeof productPrices.$inferInsert
