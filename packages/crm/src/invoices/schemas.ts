import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"

/**
 * Invoices zod schemas. Services validate inputs with these; API routes reuse
 * them at the HTTP boundary via `@hono/zod-validator`. Money travels as
 * integer minor units (`*_cents`) so totals stay exact.
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

export const invoiceLineItemInputSchema = z.object({
  description: z.string().trim().min(1).max(2000),
  quantity: z.number().int().min(1).default(1),
  unitAmountCents: z.number().int().min(0).default(0),
  position: z.number().int().min(0).optional(),
})

export const createInvoiceSchema = z.object({
  number: z.string().trim().min(1).max(64),
  status: z.enum(["draft", "sent", "paid", "void"]).nullish(),
  currency: currencySchema,
  issueDate: dateStringSchema,
  dueDate: dateStringSchema,
  companyId: z.string().min(1).nullish(),
  personId: z.string().min(1).nullish(),
  quoteId: z.string().min(1).nullish(),
  ownerId: z.string().min(1).nullish(),
  notes: z.string().max(10000).nullish(),
  lineItems: z.array(invoiceLineItemInputSchema).max(50).default([]),
})

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>

export const updateInvoiceSchema = createInvoiceSchema
  .omit({ lineItems: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>

export const recordPaymentSchema = z.object({
  amountCents: z.number().int().min(1),
  currency: currencySchema,
  method: z.enum(["cash", "card", "bank_transfer", "upi", "other"]).default("other"),
  paidAt: dateStringSchema,
  reference: z.string().trim().max(255).nullish(),
  notes: z.string().max(10000).nullish(),
})

export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>

export const invoiceQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
  status: z.enum(["draft", "sent", "paid", "void"]).optional(),
})

export type InvoiceQuery = z.infer<typeof invoiceQuerySchema>

export const invoiceSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  number: z.string(),
  status: z.string(),
  currency: z.string(),
  issueDate: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  companyId: z.string().nullable().optional(),
  personId: z.string().nullable().optional(),
  quoteId: z.string().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type InvoiceDto = z.infer<typeof invoiceSchema>
