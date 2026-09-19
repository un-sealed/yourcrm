import { z } from "zod"

/**
 * Notification contracts. Domain services enqueue via `queueNotification()`;
 * delivery (websocket push, email, mobile push) is a worker concern fed by
 * the `notifications` table + events. Realtime fan-out rides the API
 * WebSocket channel `workspace:<id>` (see apps/api).
 */

export const notificationSchema = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  type: z.string().min(1),
  title: z.string().min(1).max(255),
  body: z.string().optional(),
})

export type NotificationInput = z.infer<typeof notificationSchema>

export type QueuedNotification = NotificationInput & {
  id: string
  createdAt: string
}

export function queueNotification(input: NotificationInput): QueuedNotification {
  const parsed = notificationSchema.parse(input)
  return {
    ...parsed,
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    createdAt: new Date().toISOString(),
  }
}
