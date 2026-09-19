"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import {
  Badge,
  buttonVariants,
  DataTable,
  DatePicker,
  EmptyState,
  ErrorState,
  Field,
  Skeleton,
  type DataTableColumn,
} from "@yourcrm/ui"
import { ApiError, apiFetchRaw } from "@/lib/api-client"
import { formatEventDateTime } from "../local-time"
import type { CalendarEvent, CalendarEventListResponse } from "../types"

function isoDateAt(dateOnly: string, endOfDay = false): string {
  return `${dateOnly}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`
}

function addDays(dateOnly: string, days: number): string {
  const d = new Date(`${dateOnly}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function todayDateOnly(): string {
  return new Date().toISOString().slice(0, 10)
}

function agendaColumns(timezone: string): DataTableColumn<CalendarEvent>[] {
  return [
    {
      id: "when",
      header: "When",
      sortable: true,
      accessor: (row) => (
        <Link href={`/app/calendar/${row.id}`} className="font-medium text-primary hover:underline">
          {row.allDay
            ? formatEventDateTime(row.startAt, timezone).slice(0, 10)
            : formatEventDateTime(row.startAt, timezone)}
        </Link>
      ),
    },
    {
      id: "title",
      header: "Title",
      accessor: (row) => (
        <Link href={`/app/calendar/${row.id}`} className="hover:underline">
          {row.title}
        </Link>
      ),
    },
    {
      id: "location",
      header: "Location",
      accessor: (row) => row.location ?? <span className="text-muted-foreground">—</span>,
    },
    {
      id: "status",
      header: "Status",
      accessor: (row) => (
        <Badge tone={row.status === "confirmed" ? "success" : "secondary"}>{row.status}</Badge>
      ),
    },
  ]
}

/** Calendar agenda view: a flat, date-ranged list of events (list-view counterpart to the month grid). */
export default function CalendarAgendaPage() {
  const searchParams = useSearchParams()
  const focusDate = searchParams.get("date")

  const [from, setFrom] = useState(() => focusDate ?? todayDateOnly())
  const [to, setTo] = useState(() => addDays(focusDate ?? todayDateOnly(), 30))
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [workspaceTimezone, setWorkspaceTimezone] = useState("UTC")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({
        from: isoDateAt(from),
        to: isoDateAt(to, true),
        limit: "200",
        order: "asc",
      })
      const res = await apiFetchRaw<CalendarEventListResponse>(
        `/api/v1/calendar-events?${qs.toString()}`,
      )
      setEvents(res.data)
      setWorkspaceTimezone(res.workspaceTimezone)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load calendar events.")
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => {
    void load()
  }, [load])

  const columns = useMemo(() => agendaColumns(workspaceTimezone), [workspaceTimezone])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Agenda</h1>
        <div className="flex items-center gap-2">
          <Link href="/app/calendar" className={buttonVariants({ variant: "outline" })}>
            Month view
          </Link>
          <Link href="/app/calendar/new" className={buttonVariants()}>
            New event
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Field label="From" htmlFor="agenda-from">
          <DatePicker
            id="agenda-from"
            value={from}
            onChange={(e) => setFrom(e.currentTarget.value)}
            className="w-40"
          />
        </Field>
        <Field label="To" htmlFor="agenda-to">
          <DatePicker
            id="agenda-to"
            value={to}
            onChange={(e) => setTo(e.currentTarget.value)}
            className="w-40"
          />
        </Field>
      </div>

      {error !== null ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : loading ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading agenda">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : (
        <DataTable
          rows={events}
          columns={columns}
          getRowId={(row) => row.id}
          empty={
            <EmptyState
              title="No events in this range"
              description="Adjust the date range or create a new event."
              action={
                <Link href="/app/calendar/new" className={buttonVariants()}>
                  New event
                </Link>
              }
            />
          }
        />
      )}
    </div>
  )
}
