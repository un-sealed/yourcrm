import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"
import type { NotificationChannel, NotificationChannelToggles } from "./schemas"

/**
 * Notifications service ports (mirrors `packages/crm/src/people/types.ts` —
 * the reference pattern every module agent follows). `@yourcrm/crm` has no
 * database dependency, so the service depends on these structural ports;
 * the API layer adapts the drizzle repositories
 * (`notifications-repository.ts`, `notification-preferences-repository.ts`)
 * to them. Named `AppNotification` (never `Notification` — that's a DOM
 * global) per the module's hard naming rule.
 *
 * Pass-through record (like `PersonRecord`): only `id`/`workspaceId`/
 * `userId` are typed, everything else (type, title, body, readAt,
 * timestamps, ...) rides the `Record<string, unknown>` index signature so
 * the API layer can hand back a Drizzle row (Dates, not ISO strings)
 * without a field-by-field adapter.
 */
export type AppNotification = Record<string, unknown> & {
  id: string
  workspaceId: string
  userId: string
}

export type NotificationListQuery = {
  limit?: number
  cursor?: string
  unreadOnly?: boolean
}

export type NotificationListResult = {
  data: AppNotification[]
  pagination: { nextCursor: string | null; limit: number }
}

/** Store-layer create input: `type` is a plain string here (the zod schema narrows it to the category enum before this port is called). */
export type NotificationStoreCreateInput = {
  userId: string
  type: string
  title: string
  body?: string | null
}

export type NotificationsStore = {
  list(
    workspaceId: string,
    userId: string,
    query: NotificationListQuery,
  ): Promise<NotificationListResult>
  countUnread(workspaceId: string, userId: string): Promise<number>
  /** Scoped to (workspaceId, userId) — a notification owned by someone else is null, same as unknown. */
  findById(workspaceId: string, userId: string, id: string): Promise<AppNotification | null>
  create(
    workspaceId: string,
    input: NotificationStoreCreateInput,
    actorId?: string,
  ): Promise<AppNotification>
  /** Idempotent — see the repository doc comment. */
  markRead(workspaceId: string, userId: string, id: string): Promise<AppNotification | null>
  markAllRead(workspaceId: string, userId: string): Promise<{ updated: number }>
  softDelete(workspaceId: string, userId: string, id: string, actorId?: string): Promise<void>
}

/** Structural mirror of the `notification_preferences` row. */
export type NotificationPreferenceRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  userId: string
  categories: Record<string, Partial<NotificationChannelToggles>>
  quietHoursEnabled: boolean
  quietHoursStart: string | null
  quietHoursEnd: string | null
  timezone: string
}

export type NotificationPreferencesPatch = {
  categories?: Record<string, Partial<NotificationChannelToggles>>
  quietHoursEnabled?: boolean
  quietHoursStart?: string | null
  quietHoursEnd?: string | null
  timezone?: string
}

export type NotificationPreferencesStore = {
  get(workspaceId: string, userId: string): Promise<NotificationPreferenceRecord | null>
  upsert(
    workspaceId: string,
    userId: string,
    patch: NotificationPreferencesPatch,
    actorId?: string,
  ): Promise<NotificationPreferenceRecord>
}

/**
 * Delivery port for the non-in-app channels (P0 scope note, spec
 * 43-notifications §"Scope"/"Email/push/SMS channels are modelled in
 * preferences but not delivered").
 *
 * A user can already turn `email` / `push` / `sms` on per category in
 * preferences, and `notification_preferences.categories` persists the
 * choice, but nothing in this package calls this port in P0 — `create()`
 * only ever writes the in-app row (or suppresses it). A later worker wires
 * a real adapter (e.g. `apps/worker/src/jobs/notification-delivery.ts`
 * behind BullMQ, consistent with `docs/architecture.md`'s "Background
 * jobs" seam) and the service starts calling it for channels a user has
 * enabled, emitting `NotificationEvents.Delivered` / `.Failed` on the
 * outcome. Until then this type exists only to document the boundary.
 */
export type NotificationDeliveryPort = {
  deliver(
    channel: Exclude<NotificationChannel, "in_app">,
    input: { workspaceId: string; userId: string; title: string; body?: string | null },
  ): Promise<void>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type NotificationAuditInput = {
  workspaceId: string
  actorId?: string | null
  action: string
  object: string
  recordId?: string | null
  before?: unknown
  after?: unknown
  correlationId?: string | null
  source?: "user" | "automation" | "ai" | "integration" | "mcp"
}

export type NotificationsServiceContext = ServiceContext

export type NotificationsServiceDeps = {
  store: NotificationsStore
  preferencesStore: NotificationPreferencesStore
  audit: AuditWriter<NotificationAuditInput>
  events?: EventEmitter
  now?: () => Date
  /** P0: left undefined everywhere. See `NotificationDeliveryPort`. */
  delivery?: NotificationDeliveryPort
}
