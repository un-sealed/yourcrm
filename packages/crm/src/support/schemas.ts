import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"

/**
 * Support ticket zod schemas. Services validate inputs with these; API
 * routes reuse them at the HTTP boundary via `@hono/zod-validator`.
 *
 * Deliberately absent from every input schema: `firstResponseDueAt`,
 * `firstResponseAt`, `resolutionDueAt`, `resolvedAt`, `closedAt` and
 * `status`. SLA due dates are always server-computed from `priority`
 * (see `computeSupportTicketSla` in `./service`); the actual response/
 * resolution timestamps are set by the service when they really happen;
 * and `status` only ever advances through `SupportTicketService.transition`,
 * which validates the edge against an explicit transition table. None of
 * these schemas gives a client a field to set any of that directly — the
 * same "no field to strip a value into" guarantee `quotes` uses for totals.
 */

export const SUPPORT_TICKET_STATUS_VALUES = [
  "new",
  "open",
  "pending",
  "resolved",
  "closed",
] as const

export const SUPPORT_TICKET_PRIORITY_VALUES = ["low", "normal", "high", "urgent"] as const

export const SUPPORT_TICKET_CHANNEL_VALUES = [
  "email",
  "chat",
  "whatsapp",
  "phone",
  "web",
  "api",
  "manual",
] as const

export const createSupportTicketSchema = z.object({
  subject: z.string().trim().min(1).max(255),
  description: z.string().max(20000).nullish(),
  priority: z.enum(SUPPORT_TICKET_PRIORITY_VALUES).nullish(),
  requesterId: z.string().min(1),
  assigneeId: z.string().min(1).nullish(),
  channel: z.enum(SUPPORT_TICKET_CHANNEL_VALUES).nullish(),
})

export type CreateSupportTicketInput = z.infer<typeof createSupportTicketSchema>

// `requesterId` and `status` are deliberately excluded: the requester is
// fixed at intake (re-pointing a ticket at a different person is a merge/
// split concern, out of P0 scope), and status only advances through
// `transition()` — see the module header.
export const updateSupportTicketSchema = createSupportTicketSchema
  .omit({ requesterId: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateSupportTicketInput = z.infer<typeof updateSupportTicketSchema>

export const transitionSupportTicketSchema = z.object({
  status: z.enum(SUPPORT_TICKET_STATUS_VALUES),
})

export type TransitionSupportTicketInput = z.infer<typeof transitionSupportTicketSchema>

export const supportTicketQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
  status: z.enum(SUPPORT_TICKET_STATUS_VALUES).optional(),
  priority: z.enum(SUPPORT_TICKET_PRIORITY_VALUES).optional(),
  assigneeId: z.string().min(1).optional(),
  requesterId: z.string().min(1).optional(),
})

export type SupportTicketQuery = z.infer<typeof supportTicketQuerySchema>

export const supportTicketSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  subject: z.string(),
  description: z.string().nullable().optional(),
  status: z.string(),
  priority: z.string(),
  requesterId: z.string(),
  assigneeId: z.string().nullable().optional(),
  channel: z.string(),
  firstResponseDueAt: z.unknown(),
  firstResponseAt: z.unknown(),
  resolutionDueAt: z.unknown(),
  resolvedAt: z.unknown(),
  closedAt: z.unknown(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type SupportTicketDto = z.infer<typeof supportTicketSchema>

export const createSupportTicketCommentSchema = z.object({
  body: z.string().trim().min(1).max(10000),
  isInternal: z.boolean().default(false),
})

export type CreateSupportTicketCommentInput = z.infer<typeof createSupportTicketCommentSchema>

export const supportTicketCommentSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  ticketId: z.string(),
  authorId: z.string(),
  body: z.string(),
  isInternal: z.boolean(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type SupportTicketCommentDto = z.infer<typeof supportTicketCommentSchema>
