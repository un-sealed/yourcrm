import { z } from "zod"

/**
 * Notifications zod schemas (spec 43-notifications, P0). Services validate
 * inputs with these; API routes reuse them at the HTTP boundary via
 * `@hono/zod-validator`, exactly like every other module.
 */

/**
 * Notification categories (spec 43 §3 scope checklist, minus the ones not
 * yet wired by any producer module). `type` on the `notifications` row IS
 * the category — there is no separate mapping table. New producer modules
 * extend this list; it stays a closed enum (not free text) so preferences
 * can be modelled per category. `"automation"` matches the literal type the
 * existing `packages/crm/src/automation` `notify` action already writes.
 */
export const NOTIFICATION_CATEGORIES = [
  "mention",
  "assignment",
  "task_reminder",
  "deal_stage",
  "sla_escalation",
  "automation",
  "automation_failure",
  "ai_approval",
  "integration_failure",
  "general",
] as const

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return typeof value === "string" && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value)
}

/**
 * Delivery channels. P0 only ever delivers `in_app` — `email` / `push` /
 * `sms` are modelled (a user can toggle them) but nothing delivers on them
 * yet, see `NotificationDeliveryPort` in `types.ts`.
 */
export const NOTIFICATION_CHANNELS = ["in_app", "email", "push", "sms"] as const

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

export const notificationChannelTogglesSchema = z.object({
  in_app: z.boolean(),
  email: z.boolean(),
  push: z.boolean(),
  sms: z.boolean(),
})

export type NotificationChannelToggles = z.infer<typeof notificationChannelTogglesSchema>

/** Default toggles for a category with no explicit preference row: in-app only. */
export const DEFAULT_CHANNEL_TOGGLES: NotificationChannelToggles = {
  in_app: true,
  email: false,
  push: false,
  sms: false,
}

const partialChannelTogglesSchema = notificationChannelTogglesSchema.partial()

const categoryEnumSchema = z.enum(NOTIFICATION_CATEGORIES)

/** Partial map: only categories the caller wants to override need to be present. */
export const notificationCategoryPatchSchema = z.record(
  categoryEnumSchema,
  partialChannelTogglesSchema,
)

const hhmmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected "HH:MM" (24h)')

export const createAppNotificationSchema = z.object({
  userId: z.string().min(1),
  type: categoryEnumSchema,
  title: z.string().trim().min(1).max(255),
  body: z.string().max(10000).nullish(),
})

export type CreateAppNotificationInput = z.infer<typeof createAppNotificationSchema>

// `unreadOnly` arrives as a query STRING over HTTP, so `"true" | "false"` is
// accepted alongside a plain boolean (direct service-layer calls) rather
// than `z.coerce.boolean()` — coercion would read `?unreadOnly=false` as
// `true` (same gotcha `unified-inbox/schemas.ts` documents).
const booleanFlagSchema = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => value === true || value === "true")

export const notificationListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(25),
  cursor: z.string().optional(),
  unreadOnly: booleanFlagSchema.default(false),
})

export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>

export const updateNotificationPreferencesSchema = z
  .object({
    categories: notificationCategoryPatchSchema.optional(),
    quietHoursEnabled: z.boolean().optional(),
    quietHoursStart: hhmmSchema.nullish(),
    quietHoursEnd: hhmmSchema.nullish(),
    timezone: z.string().trim().min(1).max(64).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateNotificationPreferencesInput = z.infer<typeof updateNotificationPreferencesSchema>

export const appNotificationSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  type: z.string(),
  title: z.string(),
  body: z.string().nullable().optional(),
  readAt: z.union([z.string(), z.date()]).nullable().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type AppNotificationDto = z.infer<typeof appNotificationSchema>

export const notificationPreferenceSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  categories: z.record(z.string(), partialChannelTogglesSchema),
  quietHoursEnabled: z.boolean(),
  quietHoursStart: z.string().nullable(),
  quietHoursEnd: z.string().nullable(),
  timezone: z.string(),
})

export type NotificationPreferenceDto = z.infer<typeof notificationPreferenceSchema>
