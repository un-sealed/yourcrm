import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"

/**
 * Products zod schemas. Services validate inputs with these; API routes reuse
 * them at the HTTP boundary via `@hono/zod-validator`.
 */

export const productPriceInputSchema = z.object({
  currency: z
    .string()
    .trim()
    .min(1)
    .max(3)
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{3}$/, { message: "currency must be a 3-letter ISO code" })),
  unitAmount: z.number().finite().min(0).max(999999999999),
})

export const createProductSchema = z.object({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(255),
  description: z.string().max(10000).nullish(),
  ownerId: z.string().min(1).nullish(),
  isActive: z.boolean().default(true),
  prices: z.array(productPriceInputSchema).max(20).default([]),
})

export type CreateProductInput = z.infer<typeof createProductSchema>

export const updateProductSchema = createProductSchema
  .omit({ prices: true })
  .partial()
  .extend({ prices: z.array(productPriceInputSchema).max(20).optional() })
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateProductInput = z.infer<typeof updateProductSchema>

export const productQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
  active: z.enum(["true", "false"]).optional(),
})

export type ProductQuery = z.infer<typeof productQuerySchema>

export const productPriceSchema = z.object({
  id: z.string(),
  productId: z.string(),
  currency: z.string(),
  unitAmount: z.unknown(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export const productSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  sku: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  isActive: z.boolean(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type ProductDto = z.infer<typeof productSchema>
export type ProductPriceDto = z.infer<typeof productPriceSchema>
