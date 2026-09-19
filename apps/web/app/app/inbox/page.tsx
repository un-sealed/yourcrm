"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import {
  Badge,
  Button,
  buttonVariants,
  EmptyState,
  ErrorState,
  Select,
  Skeleton,
} from "@yourcrm/ui"
import { ApiError, apiFetchRaw } from "@/lib/api-client"
import {
  DEFAULT_INBOX_FILTERS,
  formatInboxTimestamp,
  INBOX_CHANNEL_LABELS,
  inboxChannelTone,
  inboxItemHeadline,
  inboxItemHref,
  inboxItemSubline,
  inboxQueryString,
  type InboxFilters,
  type InboxItem,
  type InboxListResponse,
} from "./types"

/**
 * Unified inbox stream (spec 15-unified-inbox, P0).
 *
 * One ordered list across email threads, WhatsApp conversations and calls,
 * with the filters the API supports (channel, read state, assignment,
 * archived) and the three mutations it exposes (claim/unassign, read/unread,
 * archive/restore). Opening an item navigates to the owning module's detail
 * page — this page renders no thread, no composer and no call detail.
 *
 * Every mutation refetches the page rather than patching state optimistically:
 * the read/unread flag is derived server-side from a watermark against the
 * conversation's last activity, so the server's answer is the only correct one.
 */
export default function UnifiedInboxPage() {
  const [items, setItems] = useState<InboxItem[]>([])
  const [pagination, setPagination] = useState<{ nextCursor: string | null; limit: number }>({
    nextCursor: null,
    limit: 25,
  })
  const [cursor, setCursor] = useState<string | null>(null)
  const [filters, setFilters] = useState<InboxFilters>(DEFAULT_INBOX_FILTERS)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetchRaw<InboxListResponse>(
        `/api/v1/inbox?${inboxQueryString(filters, cursor)}`,
      )
      setItems(res.data)
      setPagination(res.pagination)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the inbox.")
    } finally {
      setLoading(false)
    }
  }, [cursor, filters])

  useEffect(() => {
    void load()
  }, [load])

  const updateFilters = (patch: Partial<InboxFilters>) => {
    setCursor(null)
    setFilters((current) => ({ ...current, ...patch }))
  }

  const act = useCallback(
    async (item: InboxItem, path: string, method: "POST" | "DELETE") => {
      setBusyId(item.id)
      setError(null)
      try {
        await apiFetchRaw(`/api/v1/inbox/${item.channel}/${item.sourceId}${path}`, { method })
        await load()
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "That action could not be completed.")
      } finally {
        setBusyId(null)
      }
    },
    [load],
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Inbox</h1>
        <p className="text-sm text-muted-foreground">Email, WhatsApp and calls in one stream.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Filter by channel"
          value={filters.channel}
          onChange={(e) =>
            updateFilters({ channel: e.currentTarget.value as InboxFilters["channel"] })
          }
          className="w-44"
          options={[
            { value: "", label: "All channels" },
            { value: "email", label: "Email" },
            { value: "whatsapp", label: "WhatsApp" },
            { value: "call", label: "Calls" },
          ]}
        />
        <Select
          aria-label="Filter by read state"
          value={filters.readState}
          onChange={(e) =>
            updateFilters({ readState: e.currentTarget.value as InboxFilters["readState"] })
          }
          className="w-40"
          options={[
            { value: "", label: "Read and unread" },
            { value: "unread", label: "Unread only" },
            { value: "read", label: "Read only" },
          ]}
        />
        <Select
          aria-label="Filter by assignment"
          value={filters.assigned}
          onChange={(e) =>
            updateFilters({ assigned: e.currentTarget.value as InboxFilters["assigned"] })
          }
          className="w-48"
          options={[
            { value: "anyone", label: "Anyone" },
            { value: "me", label: "Assigned to me" },
            { value: "unassigned", label: "Unassigned" },
          ]}
        />
        <Select
          aria-label="Filter by archived state"
          value={filters.archived ? "archived" : "live"}
          onChange={(e) => updateFilters({ archived: e.currentTarget.value === "archived" })}
          className="w-40"
          options={[
            { value: "live", label: "Inbox" },
            { value: "archived", label: "Archived" },
          ]}
        />
      </div>

      {error !== null ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : loading && items.length === 0 ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading inbox">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title={filters.archived ? "Nothing archived" : "Your inbox is empty"}
          description={
            filters.archived
              ? "Conversations you archive from the inbox appear here."
              : "Conversations show up here automatically as email, WhatsApp messages and calls arrive. Start one from Email, WhatsApp or Calling."
          }
          action={
            <Link href="/app/email/new" className={buttonVariants()}>
              Send an email
            </Link>
          }
        />
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border">
          {items.map((item) => {
            const busy = busyId === item.id
            return (
              <li
                key={item.id}
                className={`flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${
                  item.unread ? "bg-accent/40" : ""
                }`}
              >
                <Link
                  href={inboxItemHref(item)}
                  className="flex min-w-0 flex-1 flex-col gap-1 hover:underline"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone={inboxChannelTone(item.channel)}>
                      {INBOX_CHANNEL_LABELS[item.channel]}
                    </Badge>
                    <span className={`truncate ${item.unread ? "font-semibold" : "font-medium"}`}>
                      {inboxItemHeadline(item)}
                    </span>
                    {item.unread ? <Badge tone="default">Unread</Badge> : null}
                    {item.assignedTo ? <Badge tone="outline">Assigned</Badge> : null}
                    {item.archived ? <Badge tone="secondary">Archived</Badge> : null}
                  </span>
                  <span className="truncate text-sm text-muted-foreground">
                    {inboxItemSubline(item)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatInboxTimestamp(item.sortAt)}
                  </span>
                </Link>

                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        item,
                        item.assignedTo ? "/assignee" : "/assignee/me",
                        item.assignedTo ? "DELETE" : "POST",
                      )
                    }
                  >
                    {item.assignedTo ? "Unassign" : "Assign to me"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void act(item, "/read", item.unread ? "POST" : "DELETE")}
                  >
                    {item.unread ? "Mark read" : "Mark unread"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void act(item, "/archive", item.archived ? "DELETE" : "POST")}
                  >
                    {item.archived ? "Restore" : "Archive"}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {!error && (pagination.nextCursor || cursor) ? (
        <div className="flex items-center justify-between">
          <Button variant="outline" size="sm" disabled={!cursor} onClick={() => setCursor(null)}>
            Newest
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!pagination.nextCursor}
            onClick={() => setCursor(pagination.nextCursor)}
          >
            Older
          </Button>
        </div>
      ) : null}
    </div>
  )
}
