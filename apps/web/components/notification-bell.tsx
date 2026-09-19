"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { Badge, Button, EmptyState, ErrorState, Skeleton } from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import type { AppNotification, NotificationListResponse } from "@/app/app/notifications/types"

const POLL_INTERVAL_MS = 20_000
const PANEL_LIMIT = 8

/**
 * Notification bell + panel — the one component `app-shell.tsx` inserts
 * into the header (see the header change there for the exact diff).
 *
 * REALTIME: polls `/notifications/unread-count` every 20s rather than
 * opening the `workspace:<id>` WebSocket the API already serves at
 * `GET /api/v1/notifications/ws` (see
 * `apps/api/src/routes/modules/notifications.ts` "REALTIME" doc comment
 * and `apps/api/src/realtime/hub.ts`). Polling keeps this component simple
 * and resilient to dev-server reloads; wiring it to the socket instead is a
 * drop-in follow-up (replace the interval with a `WebSocket` that
 * invalidates the same state on message).
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false)
  const [unread, setUnread] = useState(0)
  const [items, setItems] = useState<AppNotification[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshCount = useCallback(async () => {
    try {
      const res = await apiFetch<{ count: number }>("/api/v1/notifications/unread-count")
      setUnread(res.count)
    } catch {
      // Best-effort: a failed poll just leaves the last known count.
    }
  }, [])

  useEffect(() => {
    void refreshCount()
    const id = window.setInterval(() => void refreshCount(), POLL_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [refreshCount])

  const loadPanel = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetchRaw<NotificationListResponse>(
        `/api/v1/notifications?limit=${PANEL_LIMIT}`,
      )
      setItems(res.data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load notifications.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void loadPanel()
  }, [open, loadPanel])

  const markRead = async (id: string) => {
    try {
      await apiFetch(`/api/v1/notifications/${id}/read`, { method: "POST" })
      setItems((prev) =>
        prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)),
      )
      void refreshCount()
    } catch {
      // Non-fatal: the row stays unread in the UI, matches server state.
    }
  }

  const markAllRead = async () => {
    try {
      await apiFetch("/api/v1/notifications/read-all", { method: "POST" })
      setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })))
      setUnread(0)
    } catch {
      void refreshCount()
    }
  }

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="relative"
      >
        🔔
        {unread > 0 ? (
          <Badge tone="destructive" className="absolute -right-1 -top-1 px-1.5 py-0 text-[10px]">
            {unread > 99 ? "99+" : unread}
          </Badge>
        ) : null}
      </Button>

      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            role="dialog"
            aria-label="Notifications"
            className="absolute right-0 z-50 mt-2 w-96 max-w-[90vw] rounded-lg border bg-background shadow-xl"
          >
            <div className="flex items-center justify-between border-b px-3 py-2">
              <h2 className="text-sm font-semibold">Notifications</h2>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => void markAllRead()}>
                  Mark all read
                </Button>
                <Link
                  href="/app/settings/notifications"
                  className="text-xs text-muted-foreground hover:underline"
                  onClick={() => setOpen(false)}
                >
                  Settings
                </Link>
              </div>
            </div>

            <div className="max-h-96 overflow-y-auto p-2">
              {loading ? (
                <div
                  className="flex flex-col gap-2 p-2"
                  aria-busy="true"
                  aria-label="Loading notifications"
                >
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : error !== null ? (
                <ErrorState message={error} onRetry={() => void loadPanel()} />
              ) : items.length === 0 ? (
                <EmptyState title="No notifications yet" description="You're all caught up." />
              ) : (
                <ul className="flex flex-col gap-1">
                  {items.map((n) => (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => void markRead(n.id)}
                        className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-2 text-left text-sm hover:bg-accent"
                      >
                        <span className="flex w-full items-center gap-2">
                          {n.readAt === null ? (
                            <span
                              aria-hidden="true"
                              className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                            />
                          ) : (
                            <span className="h-1.5 w-1.5 shrink-0" />
                          )}
                          <span className={n.readAt === null ? "font-medium" : undefined}>
                            {n.title}
                          </span>
                        </span>
                        {n.body ? (
                          <span className="pl-3.5 text-xs text-muted-foreground line-clamp-2">
                            {n.body}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="border-t px-3 py-2">
              <Link
                href="/app/notifications"
                className="text-xs text-primary hover:underline"
                onClick={() => setOpen(false)}
              >
                View all notifications
              </Link>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}
