/**
 * Notification DTOs, mirroring `@yourcrm/crm/src/notifications/schemas.ts`.
 * Not imported directly: `docs/architecture.md` says the web app talks to
 * the API via `lib/api-client.ts` only, `apps/web/package.json` has no
 * `@yourcrm/crm` dependency, and this module may not add one (CLAUDE.md
 * hard rule: no `bun add`, no editing `package.json`) — same choice
 * `apps/web/app/app/calendar/local-time.ts` documents for the timezone
 * helper. The category/channel lists are small and change rarely, so the
 * duplication is cheap.
 */

/** Notification as returned by `GET /api/v1/notifications` (envelope `data` item). */
export type AppNotification = {
  id: string
  workspaceId: string
  userId: string
  type: string
  title: string
  body: string | null
  readAt: string | null
  createdAt: string
  updatedAt: string
}

export type NotificationListResponse = {
  data: AppNotification[]
  pagination: { nextCursor: string | null; limit: number }
}

/** Keep in sync with `NOTIFICATION_CATEGORIES` in `@yourcrm/crm/src/notifications/schemas.ts`. */
export const NOTIFICATION_CATEGORY_LABELS: Record<string, string> = {
  mention: "Mentions",
  assignment: "Assignments",
  task_reminder: "Task reminders",
  deal_stage: "Deal stage changes",
  sla_escalation: "SLA escalations",
  automation: "Automation",
  automation_failure: "Automation failures",
  ai_approval: "AI approval requests",
  integration_failure: "Integration failures",
  general: "General",
}

export const NOTIFICATION_CATEGORIES = Object.keys(NOTIFICATION_CATEGORY_LABELS)

export function categoryLabel(category: string): string {
  return NOTIFICATION_CATEGORY_LABELS[category] ?? category
}

export type NotificationChannel = "in_app" | "email" | "push" | "sms"

export const NOTIFICATION_CHANNELS: {
  key: NotificationChannel
  label: string
  deliverable: boolean
}[] = [
  { key: "in_app", label: "In-app", deliverable: true },
  { key: "email", label: "Email", deliverable: false },
  { key: "push", label: "Push", deliverable: false },
  { key: "sms", label: "SMS", deliverable: false },
]

export type NotificationChannelToggles = {
  in_app: boolean
  email: boolean
  push: boolean
  sms: boolean
}

export const DEFAULT_CHANNEL_TOGGLES: NotificationChannelToggles = {
  in_app: true,
  email: false,
  push: false,
  sms: false,
}

/** As returned by `GET /api/v1/notifications/preferences` (`data` is `null` until the user saves once). */
export type NotificationPreference = {
  id: string
  workspaceId: string
  userId: string
  categories: Record<string, Partial<NotificationChannelToggles>>
  quietHoursEnabled: boolean
  quietHoursStart: string | null
  quietHoursEnd: string | null
  timezone: string
}

export function resolveChannels(
  pref: NotificationPreference | null,
  category: string,
): NotificationChannelToggles {
  const override = pref?.categories[category]
  if (!override) return DEFAULT_CHANNEL_TOGGLES
  return { ...DEFAULT_CHANNEL_TOGGLES, ...override }
}
