import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"

/**
 * Quotes zod schemas. Services validate inputs with these; API routes reuse
 * them at the HTTP boundary via `@hono/zod-validator`. Money travels as
 * integer minor units (`*_cents`); discount/tax rates travel as integer
 * basis points (`*Bps`) so totals stay exact.
 *
 * Deliberately absent: subtotal/discount/tax/grandTotal. Totals are always
 * server-computed (see `computeTotals` in `./service`) from line items plus
 * `discountType`/`discountValue`/`taxRateBps` — these schemas have no field
 * for a client-supplied total, so `.parse()` strips one out if sent.
 */

const currencySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, "currency must be a 3-letter code")
  .transform((value) => value.toUpperCase())
  .nullish()

const dateStringSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .refine((value) => !Number.isNaN(Date.parse(value)), "must be a valid date")
  .nullish()

export const quoteLineItemInputSchema = z.object({
  description: z.string().trim().min(1).max(2000),
  productId: z.string().min(1).nullish(),
  quantity: z.number().int().min(1).default(1),
  unitAmountCents: z.number().int().min(0).default(0),
  position: z.number().int().min(0).optional(),
})

export const createQuoteSchema = z.object({
  number: z.string().trim().min(1).max(64),
  status: z.enum(["draft", "sent", "accepted", "rejected"]).nullish(),
  currency: currencySchema,
  expiresAt: dateStringSchema,
  companyId: z.string().min(1).nullish(),
  personId: z.string().min(1).nullish(),
  dealId: z.string().min(1).nullish(),
  ownerId: z.string().min(1).nullish(),
  discountType: z.enum(["none", "percent", "fixed"]).nullish(),
  discountValue: z.number().int().min(0).nullish(),
  taxRateBps: z.number().int().min(0).nullish(),
  terms: z.string().max(10000).nullish(),
  notes: z.string().max(10000).nullish(),
  lineItems: z.array(quoteLineItemInputSchema).max(200).default([]),
})

export type CreateQuoteInput = z.infer<typeof createQuoteSchema>

// `status` is deliberately excluded: the draft -> sent -> accepted|rejected
// lifecycle only advances through the `send`/`accept`/`reject` service
// methods (and their `/:id/send`, `/:id/accept`, `/:id/reject` routes),
// which validate the transition. A generic PATCH must not be able to set an
// arbitrary status and bypass that check.
export const updateQuoteSchema = createQuoteSchema
  .omit({ lineItems: true, status: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateQuoteInput = z.infer<typeof updateQuoteSchema>

export const quoteQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
  status: z.enum(["draft", "sent", "accepted", "rejected"]).optional(),
})

export type QuoteQuery = z.infer<typeof quoteQuerySchema>

export const quoteSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  number: z.string(),
  status: z.string(),
  currency: z.string(),
  expiresAt: z.string().nullable().optional(),
  companyId: z.string().nullable().optional(),
  personId: z.string().nullable().optional(),
  dealId: z.string().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  discountType: z.string(),
  discountValue: z.number(),
  taxRateBps: z.number(),
  terms: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type QuoteDto = z.infer<typeof quoteSchema>
