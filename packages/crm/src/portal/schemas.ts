import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"

/**
 * Customer portal zod schemas (spec 45-customer-portal, P0).
 *
 * The list query is deliberately TINY. Every other module's list endpoint
 * takes a rich filter set; here each extra parameter is another chance to
 * express "show me somebody else's rows", so the portal accepts exactly:
 * pagination, order and a status filter drawn from a closed enum. There is
 * no `personId`, no `companyId`, no `ownerId`, no free-text query and no
 * filter tree — and because these schemas `.parse()` (strip) rather than
 * pass through, sending one of those has no effect at all.
 */

export const portalMagicLinkRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
})

export type PortalMagicLinkRequestInput = z.infer<typeof portalMagicLinkRequestSchema>

export const portalSessionExchangeSchema = z.object({
  /** Raw magic-link token. base64url, 32 CSPRNG bytes (@yourcrm/auth). */
  token: z.string().trim().min(16).max(512),
})

export type PortalSessionExchangeInput = z.infer<typeof portalSessionExchangeSchema>

/** Portal-visible invoice statuses (drafts and voids are internal). */
export const portalInvoiceStatusSchema = z.enum(["sent", "paid"])

/** Portal-visible quote statuses (drafts are internal). */
export const portalQuoteStatusSchema = z.enum(["sent", "accepted", "rejected"])

export const portalTicketStatusSchema = z.enum(["open", "pending", "resolved", "closed"])

const portalPaginationSchema = paginationQuerySchema.omit({ sort: true }).extend({
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

export const portalInvoiceQuerySchema = portalPaginationSchema.extend({
  status: portalInvoiceStatusSchema.optional(),
})

export const portalQuoteQuerySchema = portalPaginationSchema.extend({
  status: portalQuoteStatusSchema.optional(),
})

export const portalTicketQuerySchema = portalPaginationSchema.extend({
  status: portalTicketStatusSchema.optional(),
})

export type PortalInvoiceQuery = z.infer<typeof portalInvoiceQuerySchema>
export type PortalQuoteQuery = z.infer<typeof portalQuoteQuerySchema>
export type PortalTicketQuery = z.infer<typeof portalTicketQuerySchema>

/* ------------------------------ response DTOs ----------------------------- */

export const portalIdentitySchema = z.object({
  /** `portal_identities.id` — never a `users.id`. */
  identityId: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  entitlements: z.object({
    tickets: z.boolean(),
    invoices: z.boolean(),
    quotes: z.boolean(),
  }),
})

export type PortalIdentityDto = z.infer<typeof portalIdentitySchema>

export const portalLineItemSchema = z.object({
  id: z.string(),
  description: z.string(),
  quantity: z.number(),
  unitAmountCents: z.number(),
  amountCents: z.number(),
})

export const portalInvoiceSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: z.string(),
  currency: z.string(),
  issueDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  totalCents: z.number(),
  amountPaidCents: z.number(),
  balanceDueCents: z.number(),
  overdue: z.boolean(),
  lineItems: z.array(portalLineItemSchema),
})

export const portalQuoteSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: z.string(),
  currency: z.string(),
  expiresAt: z.string().nullable(),
  terms: z.string().nullable(),
  subtotalCents: z.number(),
  discountCents: z.number(),
  taxCents: z.number(),
  grandTotalCents: z.number(),
  lineItems: z.array(portalLineItemSchema),
})

export const portalTicketCommentSchema = z.object({
  id: z.string(),
  body: z.string(),
  authorName: z.string().nullable(),
  authorKind: z.enum(["customer", "agent"]),
  createdAt: z.string().nullable(),
})

export const portalTicketSchema = z.object({
  id: z.string(),
  subject: z.string(),
  status: z.string(),
  priority: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  comments: z.array(portalTicketCommentSchema),
})

/**
 * Closed response schemas (`.strict()` at the boundary would reject unknown
 * keys). These are the exact shapes the API returns; the route asserts
 * against them so a redaction regression fails a test instead of shipping.
 */
export const portalInvoiceResponseSchema = portalInvoiceSchema.strict()
export const portalQuoteResponseSchema = portalQuoteSchema.strict()
export const portalTicketResponseSchema = portalTicketSchema.strict()
