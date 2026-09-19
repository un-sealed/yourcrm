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
  TextField,
} from "@yourcrm/ui"
import { ApiError, apiFetchRaw } from "@/lib/api-client"
import type { WhatsAppConversation, WhatsAppConversationListResponse } from "./types"

function formatTimestamp(value: string | null): string {
  if (!value) return "—"
  try {
    return new Date(value).toLocaleString()
  } catch {
    return "—"
  }
}

/** WhatsApp conversation list (spec 16-whatsapp, P0). */
export default function WhatsAppConversationsPage() {
  const [rows, setRows] = useState<WhatsAppConversation[]>([])
  const [pagination, setPagination] = useState<{ nextCursor: string | null; limit: number }>({
    nextCursor: null,
    limit: 25,
  })
  const [cursor, setCursor] = useState<string | null>(null)
  const [status, setStatus] = useState<string>("")
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: "25" })
      if (cursor) qs.set("cursor", cursor)
      if (status) qs.set("status", status)
      const res = await apiFetchRaw<WhatsAppConversationListResponse>(
        `/api/v1/whatsapp/conversations?${qs.toString()}`,
      )
      setRows(res.data)
      setPagination(res.pagination)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load WhatsApp conversations.")
    } finally {
      setLoading(false)
    }
  }, [cursor, status])

  useEffect(() => {
    void load()
  }, [load])

  const visible = search.trim()
    ? rows.filter((row) => row.contactPhone.includes(search.trim()))
    : rows

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">WhatsApp</h1>
        <Link href="/app/whatsapp/new" className={buttonVariants()}>
          New conversation
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <TextField
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          placeholder="Search by phone number…"
          aria-label="Search conversations"
          className="max-w-xs"
        />
        <Select
          aria-label="Filter by status"
          value={status}
          onChange={(e) => {
            setStatus(e.currentTarget.value)
            setCursor(null)
          }}
          className="w-40"
          options={[
            { value: "", label: "All statuses" },
            { value: "open", label: "Open" },
            { value: "archived", label: "Archived" },
          ]}
        />
      </div>

      {error !== null ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : loading && rows.length === 0 ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading conversations">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          title="No conversations yet"
          description="Conversations appear automatically when a contact messages you on WhatsApp, or start one from a template."
          action={
            <Link href="/app/whatsapp/new" className={buttonVariants()}>
              New conversation
            </Link>
          }
        />
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border">
          {visible.map((row) => (
            <li key={row.id}>
              <Link
                href={`/app/whatsapp/${row.id}`}
                className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-accent"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate font-medium">{row.contactPhone}</span>
                  <span className="truncate text-sm text-muted-foreground">
                    {row.lastMessagePreview ?? "No messages yet"}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {row.unreadCount > 0 ? <Badge tone="default">{row.unreadCount}</Badge> : null}
                  <Badge tone={row.status === "open" ? "success" : "secondary"}>{row.status}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {formatTimestamp(row.lastMessageAt)}
                  </span>
                </div>
              </Link>
            </li>
          ))}
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
