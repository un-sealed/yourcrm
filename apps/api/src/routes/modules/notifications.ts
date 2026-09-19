import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  appNotificationSchema,
  createNotificationsService,
  notificationListQuerySchema,
  notificationPreferenceSchema,
  updateNotificationPreferencesSchema,
  type NotificationsService,
} from "@yourcrm/crm/src/notifications"
import { getDb, writeAudit, type NotificationPreference } from "@yourcrm/database"
import { createNotificationPreferencesRepository } from "@yourcrm/database/src/repositories/notification-preferences-repository"
import { createNotificationsRepository } from "@yourcrm/database/src/repositories/notifications-repository"
import { getEventBus, NotificationEvents, type DomainEvent, type EventBus } from "@yourcrm/events"
import { PermissionDeniedError } from "@yourcrm/permissions"
import { errorEnvelope, paginatedEnvelopeSchema } from "@yourcrm/validation"
import { upgradeWebSocket } from "hono/bun"
import { Hono } from "hono"
import type { Context } from "hono"
import { z } from "zod"
import type { AppEnv } from "../../hono-env"
import { requireSession } from "../../middleware/auth"
import { zodToJsonSchema } from "../../openapi/zod-to-json-schema"
import { joinChannel, publishToChannel, workspaceChannel } from "../../realtime/hub"

/**
 * Notifications module (spec 43-notifications, P0).
 *
 * Thin HTTP layer only, mirroring `routes/modules/people.ts`: zod
 * validation at the boundary, session from the auth middleware, straight
 * into the domain service. Preference/quiet-hours suppression is enforced
 * inside `@yourcrm/crm/src/notifications` `create()` — this file never
 * re-implements it.
 *
 * REALTIME: `GET /notifications/ws` upgrades to a WebSocket on the
 * `workspace:<id>` channel (`docs/architecture.md` "Realtime" — it lands
 * with this module). It uses `upgradeWebSocket`/`websocket` from `hono/bun`,
 * which ships inside the already-declared `hono` dependency — no new
 * package. `subscribeNotificationsRealtimeDispatcher()` below is the boot
 * wire (called once from `apps/api/src/index.ts`, same one-line pattern as
 * `subscribeAutomationDispatcher`): it listens on the shared in-process
 * event bus and republishes `notification.*` events to the hub. That means
 * realtime push works today for a single API process; a second process
 * needs the Redis pub/sub seam documented in `../../realtime/hub.ts`.
 *
 * The web client currently POLLS (`apps/web/components/notification-bell.tsx`,
 * `apps/web/app/app/notifications/page.tsx`) rather than opening the socket,
 * so the feature works without relying on a WebSocket surviving a Next.js
 * dev reload; wiring the client to this endpoint is a drop-in follow-up.
 */

export const basePath = "/notifications"

const notificationEnvelope = z.object({ data: appNotificationSchema.passthrough() })
const notificationListEnvelope = paginatedEnvelopeSchema(appNotificationSchema.passthrough())
const preferencesEnvelope = z.object({ data: notificationPreferenceSchema.passthrough() })

export type NotificationsRouteDeps = {
  service?: NotificationsService
}

/**
 * Drizzle infers `categories` (jsonb) as `unknown`; the domain port wants
 * `Record<string, Partial<NotificationChannelToggles>>`. This is the one
 * spot that narrows it — the database layer stays generic, the domain
 * layer stays typed.
 */
function toPreferenceRecord(row: NotificationPreference) {
  return {
    ...row,
    categories: (row.categories ?? {}) as Record<
      string,
      Partial<{ in_app: boolean; email: boolean; push: boolean; sms: boolean }>
    >,
  }
}

function defaultService(): NotificationsService {
  const db = getDb()
  const repository = createNotificationsRepository()
  const preferencesRepository = createNotificationPreferencesRepository()
  return createNotificationsService({
    store: {
      list: (workspaceId, userId, query) => repository.list(db, { workspaceId, userId, ...query }),
      countUnread: (workspaceId, userId) => repository.countUnread(db, workspaceId, userId),
      findById: (workspaceId, userId, id) => repository.findById(db, workspaceId, userId, id),
      create: (workspaceId, input, actorId) => repository.create(db, workspaceId, input, actorId),
      markRead: (workspaceId, userId, id) => repository.markRead(db, workspaceId, userId, id),
      markAllRead: (workspaceId, userId) => repository.markAllRead(db, workspaceId, userId),
      softDelete: (workspaceId, userId, id, actorId) =>
        repository.softDelete(db, workspaceId, userId, id, actorId),
    },
    preferencesStore: {
      get: async (workspaceId, userId) => {
        const row = await preferencesRepository.get(db, workspaceId, userId)
        return row ? toPreferenceRecord(row) : null
      },
      upsert: async (workspaceId, userId, patch, actorId) =>
        toPreferenceRecord(
          await preferencesRepository.upsert(db, workspaceId, userId, patch, actorId),
        ),
    },
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "user" })
    },
    events: getEventBus(),
  })
}

function serviceContextOf(c: Context<AppEnv>) {
  const session = c.get("session") as Session | null
  return {
    workspaceId: session?.workspaceId ?? "",
    actorId: session?.user.id ?? "",
    role: session ? roleInWorkspace(session) : "viewer",
    correlationId: c.get("requestId") as string | undefined,
  }
}

function mapError(c: Context<AppEnv>, err: unknown) {
  const requestId = c.get("requestId") as string | undefined
  if (err instanceof PermissionDeniedError) {
    return c.json(errorEnvelope("FORBIDDEN", err.message, requestId), 403)
  }
  if (err instanceof Error && (err as { code?: string }).code === "NOT_FOUND") {
    return c.json(errorEnvelope("NOT_FOUND", err.message, requestId), 404)
  }
  throw err
}

export function createRoutes(deps: NotificationsRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  let cached: NotificationsService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  app.get(
    "/",
    requireSession(),
    zValidator("query", notificationListQuerySchema, (result, c) => {
      if (!result.success) {
        return c.json(
          errorEnvelope(
            "VALIDATION_ERROR",
            "Invalid query parameters",
            c.req.header("x-request-id") ?? undefined,
            result.error.flatten(),
          ),
          400,
        )
      }
    }),
    async (c) => {
      try {
        const result = await service().list(serviceContextOf(c), c.req.valid("query"))
        return c.json(result)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/unread-count", requireSession(), async (c) => {
    try {
      const count = await service().unreadCount(serviceContextOf(c))
      return c.json({ data: { count } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.get("/preferences", requireSession(), async (c) => {
    try {
      const prefs = await service().getPreferences(serviceContextOf(c))
      return c.json({ data: prefs })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.put(
    "/preferences",
    requireSession(),
    zValidator("json", updateNotificationPreferencesSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          errorEnvelope(
            "VALIDATION_ERROR",
            "Invalid request body",
            c.req.header("x-request-id") ?? undefined,
            result.error.flatten(),
          ),
          400,
        )
      }
    }),
    async (c) => {
      try {
        const prefs = await service().updatePreferences(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: prefs })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post("/read-all", requireSession(), async (c) => {
    try {
      const result = await service().markAllRead(serviceContextOf(c))
      return c.json({ data: result })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.get("/:id", requireSession(), async (c) => {
    try {
      const found = await service().get(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: found })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post("/:id/read", requireSession(), async (c) => {
    try {
      const updated = await service().markRead(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: updated })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.delete("/:id", requireSession(), async (c) => {
    try {
      await service().softDelete(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: { deleted: true } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  // Realtime seam — see the module doc comment above.
  app.get(
    "/ws",
    requireSession(),
    upgradeWebSocket((c) => {
      const session = c.get("session") as Session | null
      const channel = workspaceChannel(session?.workspaceId ?? "")
      let leave: (() => void) | null = null
      return {
        onOpen(_event, ws) {
          leave = joinChannel(channel, ws)
        },
        onClose() {
          leave?.()
          leave = null
        },
      }
    }),
  )

  return app
}

const RELEVANT_REALTIME_EVENTS: ReadonlySet<string> = new Set([
  NotificationEvents.Created,
  NotificationEvents.Read,
  NotificationEvents.AllRead,
  NotificationEvents.Deleted,
])

/**
 * Boot-time wire: republish `notification.*` domain events onto the
 * `workspace:<id>` realtime channel. Called once from `apps/api/src/index.ts`
 * (never from a route factory — route construction stays side-effect free).
 * Returns the unsubscribe function.
 */
export function subscribeNotificationsRealtimeDispatcher(
  bus: EventBus = getEventBus(),
): () => void {
  return bus.on("*", (event: DomainEvent) => {
    if (!RELEVANT_REALTIME_EVENTS.has(event.event)) return
    publishToChannel(workspaceChannel(event.workspaceId), {
      type: event.event,
      entityId: event.entityId,
      after: event.after,
      timestamp: event.timestamp,
    })
  })
}

export const openApiPaths = {
  "/api/v1/notifications": {
    get: {
      summary: "List the caller's notifications (unread-first, cursor pagination)",
      operationId: "listNotifications",
    },
  },
  "/api/v1/notifications/unread-count": {
    get: {
      summary: "Unread notification count for the bell badge",
      operationId: "unreadNotificationCount",
    },
  },
  "/api/v1/notifications/preferences": {
    get: {
      summary: "Get the caller's notification preferences",
      operationId: "getNotificationPreferences",
    },
    put: {
      summary: "Update the caller's notification preferences",
      operationId: "updateNotificationPreferences",
      requestBody: {
        content: {
          "application/json": { schema: zodToJsonSchema(updateNotificationPreferencesSchema) },
        },
      },
    },
  },
  "/api/v1/notifications/read-all": {
    post: {
      summary: "Mark every unread notification as read",
      operationId: "markAllNotificationsRead",
    },
  },
  "/api/v1/notifications/{id}": {
    get: {
      summary: "Get one notification (owner-only, 404 otherwise)",
      operationId: "getNotification",
    },
    delete: { summary: "Delete a notification", operationId: "deleteNotification" },
  },
  "/api/v1/notifications/{id}/read": {
    post: {
      summary: "Mark one notification read (idempotent)",
      operationId: "markNotificationRead",
    },
  },
}

export { notificationEnvelope, notificationListEnvelope, preferencesEnvelope }
