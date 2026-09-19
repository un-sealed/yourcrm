import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"

/**
 * Email zod schemas (spec 14-email, P0). Services validate inputs with
 * these; API routes reuse them at the HTTP boundary via
 * `@hono/zod-validator`.
 *
 * Names are prefixed `email*` on purpose: `packages/crm/src/index.ts` is one
 * `export *` barrel across every module, so a bare `messageSchema` or
 * `attachmentSchema` would collide.
 */

/**
 * A record id. Deliberately `min(1)` rather than `.uuid()`: the same rule
 * the people/integrations modules follow. Postgres columns are `uuid`, so
 * the database is the authority on format, and a stricter boundary check
 * would reject the deterministic ids the shared test fixtures mint.
 */
const emailRecordIdSchema = z.string().trim().min(1).max(64)

export const emailAddressInputSchema = z.object({
  address: z.string().trim().toLowerCase().email().max(320),
  name: z.string().trim().max(255).nullish(),
})

export type EmailAddressInput = z.infer<typeof emailAddressInputSchema>

/**
 * Attachment METADATA. `storageKey` points at an object already uploaded
 * through `@yourcrm/storage` — there is deliberately no field to POST bytes
 * or base64 through this API.
 */
export const emailAttachmentInputSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().max(128).nullish(),
  sizeBytes: z.number().int().min(0).max(2_147_483_647).nullish(),
  storageKey: z.string().trim().min(1).max(1024).nullish(),
  contentId: z.string().trim().max(255).nullish(),
  isInline: z.boolean().default(false),
})

export type EmailAttachmentInput = z.infer<typeof emailAttachmentInputSchema>

/** Compose + send. `from` defaults to the connection's configured address. */
export const sendEmailMessageSchema = z
  .object({
    /** Integration connection to send through; omitted picks the default. */
    connectionId: emailRecordIdSchema.nullish(),
    /** Append to this thread explicitly instead of resolving by headers. */
    threadId: emailRecordIdSchema.nullish(),
    /** Reply to a stored message: supplies In-Reply-To + References. */
    replyToMessageId: emailRecordIdSchema.nullish(),
    subject: z.string().trim().max(998).default(""),
    from: emailAddressInputSchema.nullish(),
    to: z.array(emailAddressInputSchema).min(1).max(50),
    cc: z.array(emailAddressInputSchema).max(50).default([]),
    bcc: z.array(emailAddressInputSchema).max(50).default([]),
    replyTo: emailAddressInputSchema.nullish(),
    bodyText: z.string().max(1_000_000).default(""),
    bodyHtml: z.string().max(2_000_000).nullish(),
    attachments: z.array(emailAttachmentInputSchema).max(25).default([]),
    /** CRM links stored on the message (plain uuid, no FK). */
    personId: emailRecordIdSchema.nullish(),
    companyId: emailRecordIdSchema.nullish(),
    dealId: emailRecordIdSchema.nullish(),
  })
  .refine((value) => value.bodyText.trim().length > 0 || (value.bodyHtml ?? "").trim().length > 0, {
    message: "an email needs a text or html body",
    path: ["bodyText"],
  })

export type SendEmailMessageInput = z.infer<typeof sendEmailMessageSchema>

/**
 * A structured inbound message, as handed over by a provider's webhook
 * handler. NOT raw RFC822: full MIME parsing is out of scope for P0, so the
 * provider is responsible for giving us parts, not bytes.
 */
export const inboundEmailMessageSchema = z.object({
  workspaceId: emailRecordIdSchema,
  connectionId: emailRecordIdSchema.nullish(),
  providerId: z.string().trim().min(1).max(64).nullish(),
  providerMessageId: z.string().trim().max(255).nullish(),
  /** RFC 5322 Message-ID. Normalised by the service before any lookup. */
  messageId: z.string().trim().max(998).nullish(),
  inReplyTo: z.string().trim().max(998).nullish(),
  /** Raw `References` header or an already-split list. */
  references: z.union([z.string().max(8000), z.array(z.string().max(998)).max(200)]).nullish(),
  subject: z.string().max(998).nullish(),
  from: emailAddressInputSchema,
  to: z.array(emailAddressInputSchema).max(200).default([]),
  cc: z.array(emailAddressInputSchema).max(200).default([]),
  bcc: z.array(emailAddressInputSchema).max(200).default([]),
  replyTo: emailAddressInputSchema.nullish(),
  bodyText: z.string().max(1_000_000).nullish(),
  bodyHtml: z.string().max(2_000_000).nullish(),
  attachments: z.array(emailAttachmentInputSchema).max(50).default([]),
  receivedAt: z.coerce.date().nullish(),
  correlationId: z.string().trim().max(128).nullish(),
})

export type InboundEmailMessageInput = z.infer<typeof inboundEmailMessageSchema>

export const emailThreadStatusSchema = z.enum(["open", "archived"])

/** Link a thread to CRM records, retitle it, or archive it. */
export const updateEmailThreadSchema = z
  .object({
    subject: z.string().trim().max(998).nullish(),
    status: emailThreadStatusSchema.optional(),
    ownerId: emailRecordIdSchema.nullish(),
    personId: emailRecordIdSchema.nullish(),
    companyId: emailRecordIdSchema.nullish(),
    dealId: emailRecordIdSchema.nullish(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateEmailThreadInput = z.infer<typeof updateEmailThreadSchema>

export const emailThreadQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
  status: emailThreadStatusSchema.optional(),
  personId: emailRecordIdSchema.optional(),
  companyId: emailRecordIdSchema.optional(),
  dealId: emailRecordIdSchema.optional(),
})

export type EmailThreadQuery = z.infer<typeof emailThreadQuerySchema>

/* ------------------------------ responses ----------------------------- */

export const emailThreadSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  subject: z.string().nullable().optional(),
  normalizedSubject: z.string().optional(),
  participantKey: z.string().optional(),
  status: z.string(),
  messageCount: z.number().optional(),
  lastMessageAt: z.unknown().optional(),
  ownerId: z.string().nullable().optional(),
  personId: z.string().nullable().optional(),
  companyId: z.string().nullable().optional(),
  dealId: z.string().nullable().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type EmailThreadDto = z.infer<typeof emailThreadSchema>

/**
 * Message DTO. `bodyHtml` is ABSENT on purpose: the stored HTML is
 * sanitised but is still provider-controlled markup, and P0 renders the text
 * part only (see `sanitize.ts`). Adding it here would hand a future client
 * an XSS foot-gun the API never needed to expose.
 */
export const emailMessageSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  threadId: z.string(),
  direction: z.string(),
  status: z.string(),
  messageId: z.string().nullable().optional(),
  inReplyTo: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  fromAddress: z.string().nullable().optional(),
  fromName: z.string().nullable().optional(),
  bodyText: z.string().nullable().optional(),
  snippet: z.string().nullable().optional(),
  hasAttachments: z.boolean().optional(),
  providerId: z.string().nullable().optional(),
  providerMessageId: z.string().nullable().optional(),
  sentAt: z.unknown().optional(),
  receivedAt: z.unknown().optional(),
  lastError: z.string().nullable().optional(),
  personId: z.string().nullable().optional(),
  companyId: z.string().nullable().optional(),
  dealId: z.string().nullable().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type EmailMessageDto = z.infer<typeof emailMessageSchema>

export const emailParticipantSchema = z.object({
  id: z.string(),
  role: z.string(),
  address: z.string(),
  displayName: z.string().nullable().optional(),
  personId: z.string().nullable().optional(),
})

export type EmailParticipantDto = z.infer<typeof emailParticipantSchema>

export const emailAttachmentSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string().nullable().optional(),
  sizeBytes: z.number().optional(),
  storageKey: z.string().nullable().optional(),
  contentId: z.string().nullable().optional(),
  isInline: z.boolean().optional(),
})

export type EmailAttachmentDto = z.infer<typeof emailAttachmentSchema>
