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
import {
  DEFAULT_SEQUENCE_FILTERS,
  formatSequenceTimestamp,
  sequenceQueryString,
  sequenceStatusTone,
  SEQUENCE_STATUS_LABELS,
  SEQUENCE_STATUSES,
  type Sequence,
  type SequenceFilters,
  type SequenceListResponse,
} from "./types"

/**
 * Sequence list (spec 47 §4, P0).
 *
 * Search, status filter, cursor pagination, and the loading, empty and
 * error states every page owes the user. Activating and pausing happen on
 * the detail page, next to the steps they affect — a one-click "activate"
 * in a list is how somebody starts emailing three hundred people by
 * accident.
 */
export default function SequencesListPage() {
  const [rows, setRows] = useState<Sequence[]>([])
  const [pagination, setPagination] = useState<{ nextCursor: string | null; limit: number }>({
    nextCursor: null,
    limit: 25,
  })
  const [cursor, setCursor] = useState<string | null>(null)
  const [filters, setFilters] = useState<SequenceFilters>(DEFAULT_SEQUENCE_FILTERS)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetchRaw<SequenceListResponse>(
        `/api/v1/sequences?${sequenceQueryString(filters, cursor)}`,
      )
      setRows(res.data)
      setPagination(res.pagination)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load your sequences.")
    } finally {
      setLoading(false)
    }
  }, [cursor, filters])

  useEffect(() => {
    void load()
  }, [load])

  const updateFilters = (patch: Partial<SequenceFilters>) => {
    setCursor(null)
    setFilters((current) => ({ ...current, ...patch }))
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Sequences</h1>
          <p className="text-sm text-muted-foreground">
            Multi-step outreach that stops the moment somebody replies.
          </p>
        </div>
        <Link href="/app/sequences/new" className={buttonVariants()}>
          New sequence
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <TextField
          aria-label="Search sequences"
          placeholder="Search by name"
          className="w-64"
          value={filters.query}
          onChange={(e) => updateFilters({ query: e.currentTarget.value })}
        />
        <Select
          aria-label="Filter by status"
          className="w-44"
          value={filters.status}
          onChange={(e) =>
            updateFilters({ status: e.currentTarget.value as SequenceFilters["status"] })
          }
          options={[
            { value: "", label: "All statuses" },
            ...SEQUENCE_STATUSES.map((status) => ({
              value: status,
              label: SEQUENCE_STATUS_LABELS[status],
            })),
          ]}
        />
      </div>

      {error !== null ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : loading && rows.length === 0 ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading sequences">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={filters.query || filters.status ? "No matching sequences" : "No sequences yet"}
          description={
            filters.query || filters.status
              ? "Try a different search or clear the status filter."
              : "A sequence is an ordered list of emails, tasks and waits. Build one, activate it, then enrol people — it stops on its own when they reply."
          }
          action={
            <Link href="/app/sequences/new" className={buttonVariants()}>
              Create your first sequence
            </Link>
          }
        />
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border">
          {rows.map((sequence) => (
            <li
              key={sequence.id}
              className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <Link
                href={`/app/sequences/${sequence.id}`}
                className="flex min-w-0 flex-1 flex-col gap-1 hover:underline"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium">{sequence.name}</span>
                  <Badge tone={sequenceStatusTone(sequence.status)}>
                    {SEQUENCE_STATUS_LABELS[sequence.status] ?? sequence.status}
                  </Badge>
                  {sequence.exitOnReply ? <Badge tone="outline">Stops on reply</Badge> : null}
                </span>
                <span className="truncate text-sm text-muted-foreground">
                  {sequence.description ?? "No description"}
                </span>
              </Link>
              <span className="shrink-0 text-xs text-muted-foreground">
                Last enrolment {formatSequenceTimestamp(sequence.lastEnrolledAt)}
              </span>
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
