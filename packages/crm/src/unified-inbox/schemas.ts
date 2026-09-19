import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"
import { INBOX_CHANNEL_NAMES } from "./types"

/**
 * Unified-inbox zod schemas. The service validates with these; the API route
 * reuses them at the HTTP boundary via `@hono/zod-validator`.
 *
 * Booleans arrive as query strings, so they are `"true" | "false"` enums
 * rather than `z.coerce.boolean()` — coercion would read `?unread=false` as
 * `true` (same choice as `products/schemas.ts`).
 */

export const inboxChannelSchema = z.enum(INBOX_CHANNEL_NAMES)

const booleanFlagSchema = z.enum(["true", "false"])

/** `"<channel>:<sourceId>"` — the id the API and the UI use for an item. */
export const inboxItemRefSchema = z.object({
  channel: inboxChannelSchema,
  sourceId: z.string().uuid(),
})

export type InboxItemRef = z.infer<typeof inboxItemRefSchema>

export const inboxItemQuerySchema = paginationQuerySchema.extend({
  /** Restrict to one channel. Absent means "every channel the caller may read". */
  channel: inboxChannelSchema.optional(),
  /** `true` = unread only, `false` = read only, absent = both. */
  unread: booleanFlagSchema.optional(),
  /** Archived items are hidden unless asked for. */
  archived: booleanFlagSchema.default("false"),
  /** `me` resolves to the caller. `assignedTo` wins when both are present. */
  assigned: z.enum(["anyone", "me", "unassigned"]).default("anyone"),
  assignedTo: z.string().uuid().optional(),
  personId: z.string().uuid().optional(),
  companyId: z.string().uuid().optional(),
  dealId: z.string().uuid().optional(),
})

export type InboxItemQuery = z.infer<typeof inboxItemQuerySchema>

export const assignInboxItemSchema = z.object({
  /** The user to assign. `null` unassigns — same as `DELETE .../assignee`. */
  assigneeId: z.string().uuid().nullable(),
})

export type AssignInboxItemInput = z.infer<typeof assignInboxItemSchema>

/** Response shape for one stream item. Passthrough: the store owns the rest. */
export const inboxItemSchema = z.object({
  id: z.string(),
  channel: inboxChannelSchema,
  sourceId: z.string(),
  workspaceId: z.string(),
  sortAt: z.unknown(),
  title: z.string().nullable().optional(),
  participant: z.string().nullable().optional(),
  preview: z.string().nullable().optional(),
  direction: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  personId: z.string().nullable().optional(),
  companyId: z.string().nullable().optional(),
  dealId: z.string().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  assignedTo: z.string().nullable().optional(),
  assignedAt: z.unknown(),
  readAt: z.unknown(),
  archivedAt: z.unknown(),
  unread: z.boolean(),
  archived: z.boolean(),
})

export type InboxItemDto = z.infer<typeof inboxItemSchema>
