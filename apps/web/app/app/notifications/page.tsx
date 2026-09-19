"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { Badge, Button, EmptyState, ErrorState, Skeleton, buttonVariants } from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import { categoryLabel, type AppNotification, type NotificationListResponse } from "./types"

/** Notification center: unread-first list, mark read / mark all read / delete, cursor pagination. */
export default function NotificationsPage() {
  const [rows, setRows] = useState<AppNotification[]>([])
  const [pagination, setPagination] = useState<{ nextCursor: string | null; limit: number }>({
    nextCursor: null,
    limit: 25,
  })
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [workingId, setWorkingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: "25" })
      if (cursor) qs.set("cursor", cursor)
      const res = await apiFetchRaw<NotificationListResponse>(
        `/api/v1/notifications?${qs.toString()}`,
      )
      setRows((prev) => (cursor ? [...prev, ...res.data] : res.data))
      setPagination(res.pagination)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load notifications.")
    } finally {
      setLoading(false)
    }
  }, [cursor])

  useEffect(() => {
    void load()
  }, [load])

  const markRead = async (id: string) => {
    setWorkingId(id)
    try {
      const updated = await apiFetch<AppNotification>(`/api/v1/notifications/${id}/read`, {
        method: "POST",
      })
      setRows((prev) => prev.map((n) => (n.id === id ? updated : n)))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not mark as read.")
    } finally {
      setWorkingId(null)
    }
  }

  const markAllRead = async () => {
    try {
      await apiFetch("/api/v1/notifications/read-all", { method: "POST" })
      setRows((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not mark all as read.")
    }
  }

  const remove = async (id: string) => {
    setWorkingId(id)
    try {
      await apiFetch(`/api/v1/notifications/${id}`, { method: "DELETE" })
      setRows((prev) => prev.filter((n) => n.id !== id))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete this notification.")
    } finally {
      setWorkingId(null)
    }
  }

  const unreadCount = rows.filter((n) => n.readAt === null).length

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Notifications</h1>
        <div className="flex items-center gap-2">
          <Link
            href="/app/settings/notifications"
            className={buttonVariants({ variant: "outline" })}
          >
            Preferences
          </Link>
          <Button size="sm" disabled={unreadCount === 0} onClick={() => void markAllRead()}>
            Mark all read
          </Button>
        </div>
      </div>

      {error !== null ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : loading && rows.length === 0 ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading notifications">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No notifications yet"
          description="Mentions, assignments and automation alerts will show up here."
        />
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {rows.map((n) => (
            <li key={n.id} className="flex items-start justify-between gap-3 px-4 py-3">
              <div className="flex min-w-0 flex-1 items-start gap-3">
                {n.readAt === null ? (
                  <span
                    aria-label="Unread"
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary"
                  />
                ) : (
                  <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0" />
                )}
                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={n.readAt === null ? "text-sm font-medium" : "text-sm"}>
                      {n.title}
                    </span>
                    <Badge tone="outline">{categoryLabel(n.type)}</Badge>
                  </div>
                  {n.body ? <p className="text-sm text-muted-foreground">{n.body}</p> : null}
                  <time dateTime={n.createdAt} className="text-xs text-muted-foreground">
                    {new Date(n.createdAt).toLocaleString()}
                  </time>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {n.readAt === null ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={workingId === n.id}
                    onClick={() => void markRead(n.id)}
                  >
                    Mark read
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={workingId === n.id}
                  onClick={() => void remove(n.id)}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {pagination.nextCursor ? (
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => setCursor(pagination.nextCursor)}
        >
          {loading ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </div>
  )
}
