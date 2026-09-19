import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"

/**
 * WhatsApp zod schemas. Services validate inputs with these; API routes
 * reuse them at the HTTP boundary via `@hono/zod-validator`.
 *
 * Phone shape is intentionally loose here (`min(1).max(32)`) — E.164
 * normalisation and strict validation happen once, at the repository write
 * boundary (`normalizeWhatsAppPhone`), the same split `people/schemas.ts`
 * uses for email/phone (loose zod shape, strict repository validator).
 */

export const whatsAppConversationStatusSchema = z.enum(["open", "archived"])

export const createWhatsAppConversationSchema = z.object({
  connectionId: z.string().min(1),
  contactPhone: z.string().trim().min(1).max(32),
  personId: z.string().min(1).nullish(),
  companyId: z.string().min(1).nullish(),
})

export type CreateWhatsAppConversationInput = z.infer<typeof createWhatsAppConversationSchema>

export const updateWhatsAppConversationSchema = z
  .object({
    personId: z.string().min(1).nullable(),
    companyId: z.string().min(1).nullable(),
    status: whatsAppConversationStatusSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateWhatsAppConversationInput = z.infer<typeof updateWhatsAppConversationSchema>

export const whatsAppConversationQuerySchema = paginationQuerySchema.extend({
  status: whatsAppConversationStatusSchema.optional(),
  personId: z.string().min(1).optional(),
  companyId: z.string().min(1).optional(),
  connectionId: z.string().min(1).optional(),
})

export type WhatsAppConversationQuery = z.infer<typeof whatsAppConversationQuerySchema>

export const whatsAppMessageQuerySchema = paginationQuerySchema.pick({
  limit: true,
  cursor: true,
  order: true,
})

export type WhatsAppMessageQuery = z.infer<typeof whatsAppMessageQuerySchema>

/**
 * Send a message. `kind: "text"` is only accepted inside the 24h session
 * window (enforced in `service.ts`, not here — zod validates shape, the
 * service validates the business rule). `kind: "template"` re-opens a
 * closed window with a pre-approved template.
 */
export const sendWhatsAppTextMessageSchema = z.object({
  kind: z.literal("text"),
  body: z.string().trim().min(1).max(4096),
})

export const sendWhatsAppTemplateMessageSchema = z.object({
  kind: z.literal("template"),
  templateId: z.string().min(1),
  variables: z.array(z.string().max(1000)).max(20).default([]),
})

export const sendWhatsAppMessageSchema = z.discriminatedUnion("kind", [
  sendWhatsAppTextMessageSchema,
  sendWhatsAppTemplateMessageSchema,
])

export type SendWhatsAppMessageInput = z.infer<typeof sendWhatsAppMessageSchema>

export const createWhatsAppTemplateSchema = z.object({
  connectionId: z.string().min(1),
  name: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9_]+$/, "template name must be lower_snake_case (Meta's naming rule)"),
  language: z.string().trim().min(2).max(16).default("en_US"),
  category: z.enum(["marketing", "utility", "authentication"]).nullish(),
  bodyText: z.string().trim().min(1).max(2000),
})

export type CreateWhatsAppTemplateInput = z.infer<typeof createWhatsAppTemplateSchema>

/* ------------------------------- responses ------------------------------- */

export const whatsAppConversationSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  connectionId: z.string(),
  contactPhone: z.string(),
  personId: z.string().nullable().optional(),
  companyId: z.string().nullable().optional(),
  status: z.string(),
  lastInboundAt: z.unknown(),
  lastOutboundAt: z.unknown(),
  lastMessageAt: z.unknown(),
  lastMessagePreview: z.string().nullable().optional(),
  unreadCount: z.number(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type WhatsAppConversationDto = z.infer<typeof whatsAppConversationSchema>

export const whatsAppMessageSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  conversationId: z.string(),
  direction: z.string(),
  kind: z.string(),
  body: z.string().nullable().optional(),
  templateId: z.string().nullable().optional(),
  templateVariables: z.array(z.string()).nullable().optional(),
  mediaStorageKey: z.string().nullable().optional(),
  mediaContentType: z.string().nullable().optional(),
  mediaFileName: z.string().nullable().optional(),
  mediaSizeBytes: z.number().nullable().optional(),
  providerMessageId: z.string().nullable().optional(),
  status: z.string(),
  statusUpdatedAt: z.unknown(),
  sentAt: z.unknown(),
  deliveredAt: z.unknown(),
  readAt: z.unknown(),
  error: z.string().nullable().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type WhatsAppMessageDto = z.infer<typeof whatsAppMessageSchema>

export const whatsAppTemplateSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  connectionId: z.string(),
  name: z.string(),
  language: z.string(),
  category: z.string().nullable().optional(),
  status: z.string(),
  bodyText: z.string(),
  variableCount: z.number(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type WhatsAppTemplateDto = z.infer<typeof whatsAppTemplateSchema>
