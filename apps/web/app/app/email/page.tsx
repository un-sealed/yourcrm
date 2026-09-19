"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  Select,
  Skeleton,
  TextField,
  buttonVariants,
  type DataTableColumn,
} from "@yourcrm/ui"
import { ApiError, apiFetchRaw } from "@/lib/api-client"
import {
  EMAIL_THREAD_STATUS_OPTIONS,
  emailThreadTitle,
  formatEmailTimestamp,
  type EmailThreadListResponse,
  type EmailThreadSummary,
} from "./types"

function threadColumns(): DataTableColumn<EmailThreadSummary>[] {
  return [
    {
      id: "subject",
      header: "Subject",
      accessor: (row) => (
        <Link
          href={`/app/email/${row.id}`}
          className="font-medium text-primary hover:underline"
          title={emailThreadTitle(row)}
        >
          {emailThreadTitle(row)}
        </Link>
      ),
    },
    {
      id: "messages",
      header: "Messages",
      accessor: (row) => <span className="tabular-nums">{row.messageCount}</span>,
    },
    {
      id: "status",
      header: "Status",
      accessor: (row) => (
        <Badge tone={row.status === "open" ? "info" : "secondary"}>{row.status}</Badge>
      ),
    },
    {
      id: "linked",
      header: "Linked to",
      accessor: (row) => {
        const links = [
          row.personId ? "Person" : null,
          row.companyId ? "Company" : null,
          row.dealId ? "Deal" : null,
        ].filter((value): value is string => value !== null)
        return links.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="text-xs">{links.join(", ")}</span>
        )
      },
    },
    {
      id: "lastMessageAt",
      header: "Last activity",
      accessor: (row) => (
        <span className="whitespace-nowrap text-xs text-muted-foreground">
          {formatEmailTimestamp(row.lastMessageAt)}
        </span>
      ),
    },
  ]
}

/** Email thread list: search, status filter, cursor pagination, compose. */
export default function EmailThreadsPage() {
  const [rows, setRows] = useState<EmailThreadSummary[]>([])
  const [pagination, setPagination] = useState<{ nextCursor: string | null; limit: number }>({
    nextCursor: null,
    limit: 25,
  })
  const [cursor, setCursor] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: "25" })
      if (cursor) qs.set("cursor", cursor)
      if (search.trim() !== "") qs.set("query", search.trim())
      if (status !== "") qs.set("status", status)
      const res = await apiFetchRaw<EmailThreadListResponse>(
        `/api/v1/email/threads?${qs.toString()}`,
      )
      setRows(res.data)
      setPagination(res.pagination)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load email threads.")
    } finally {
      setLoading(false)
    }
  }, [cursor, search, status])

  useEffect(() => {
    void load()
  }, [load])

  const columns = useMemo(() => threadColumns(), [])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Email</h1>
        <Link href="/app/email/new" className={buttonVariants()}>
          Compose
        </Link>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <TextField
          value={search}
          onChange={(e) => {
            setSearch(e.currentTarget.value)
            setCursor(null)
          }}
          placeholder="Search subjects…"
          aria-label="Search email threads"
          className="max-w-md"
        />
        <Select
          value={status}
          onChange={(e) => {
            setStatus(e.currentTarget.value)
            setCursor(null)
          }}
          options={EMAIL_THREAD_STATUS_OPTIONS}
          aria-label="Filter by thread status"
          className="sm:w-40"
        />
      </div>

      {error !== null ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          getRowId={(row) => row.id}
          loading={loading}
          pagination={{ cursor, ...pagination }}
          onPageChange={(next) => setCursor(next)}
          empty={
            <EmptyState
              title="No email yet"
              description="Connect an email integration, then send your first message from here — replies thread automatically."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Link href="/app/email/new" className={buttonVariants()}>
                    Compose
                  </Link>
                  <Link href="/app/integrations" className={buttonVariants({ variant: "outline" })}>
                    Connect a provider
                  </Link>
                </div>
              }
            />
          }
        />
      )}

      {loading && rows.length === 0 && error === null ? (
        <div className="flex flex-col gap-2" aria-hidden="true">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      ) : null}

      {error === null && rows.length > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => void load()}
        >
          Refresh
        </Button>
      ) : null}
    </div>
  )
}
