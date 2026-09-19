export { createProductsService, ProductNotFoundError } from "./service"
export type { ProductsService } from "./service"
export {
  createProductSchema,
  productPriceInputSchema,
  productPriceSchema,
  productQuerySchema,
  productSchema,
  updateProductSchema,
} from "./schemas"
export type {
  CreateProductInput,
  ProductDto,
  ProductPriceDto,
  ProductQuery,
  UpdateProductInput,
} from "./schemas"
export type {
  ProductListQuery,
  ProductListResult,
  ProductPriceRecord,
  ProductRecord,
  ProductsServiceContext,
  ProductsServiceDeps,
  ProductsStore,
  ProductWithPrices,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
