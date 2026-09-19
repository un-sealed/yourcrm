"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { Button, buttonVariants, EmptyState, ErrorState, Skeleton } from "@yourcrm/ui"
import { ApiError, apiFetchRaw } from "@/lib/api-client"
import { buildMonthGrid, monthLabel, monthRangeUtcPadded, shiftMonth } from "./calendar-math"
import { formatEventTime, localCalendarDateKey } from "./local-time"
import { MonthGrid, type MonthGridEvent } from "./month-grid"
import type { CalendarEvent, CalendarEventListResponse } from "./types"

function todayParts(): { year: number; month: number } {
  const now = new Date()
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() }
}

/** Calendar month view: default landing page for `/app/calendar`. */
export default function CalendarMonthPage() {
  const initial = todayParts()
  const [year, setYear] = useState(initial.year)
  const [month, setMonth] = useState(initial.month)
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [workspaceTimezone, setWorkspaceTimezone] = useState("UTC")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const gridKeys = useMemo(() => buildMonthGrid(year, month), [year, month])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { from, to } = monthRangeUtcPadded(year, month)
      const qs = new URLSearchParams({ from, to, limit: "200" })
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
  }, [year, month])

  useEffect(() => {
    void load()
  }, [load])

  const eventsByDate = useMemo(() => {
    const map: Record<string, MonthGridEvent[]> = {}
    for (const event of events) {
      const key = localCalendarDateKey(event.startAt, workspaceTimezone)
      const bucket = (map[key] ??= [])
      bucket.push({
        id: event.id,
        title: event.title,
        allDay: event.allDay,
        time: event.allDay ? null : formatEventTime(event.startAt, workspaceTimezone),
      })
    }
    for (const bucket of Object.values(map)) {
      bucket.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""))
    }
    return map
  }, [events, workspaceTimezone])

  const todayKey = useMemo(
    () => localCalendarDateKey(new Date().toISOString(), workspaceTimezone),
    [workspaceTimezone],
  )

  const goToday = () => {
    const t = todayParts()
    setYear(t.year)
    setMonth(t.month)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Calendar</h1>
        <div className="flex items-center gap-2">
          <Link href="/app/calendar/agenda" className={buttonVariants({ variant: "outline" })}>
            Agenda
          </Link>
          <Link href="/app/calendar/new" className={buttonVariants()}>
            New event
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Previous month"
            onClick={() => {
              const next = shiftMonth(year, month, -1)
              setYear(next.year)
              setMonth(next.month)
            }}
          >
            ←
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={goToday}>
            Today
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Next month"
            onClick={() => {
              const next = shiftMonth(year, month, 1)
              setYear(next.year)
              setMonth(next.month)
            }}
          >
            →
          </Button>
        </div>
        <h2 className="text-sm font-medium text-muted-foreground">{monthLabel(year, month)}</h2>
      </div>

      {error !== null ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : loading ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading calendar">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      ) : events.length === 0 ? (
        <EmptyState
          title="No events this month"
          description="Create your first calendar event to get started."
          action={
            <Link href="/app/calendar/new" className={buttonVariants()}>
              New event
            </Link>
          }
        />
      ) : (
        <MonthGrid
          year={year}
          month={month}
          gridKeys={gridKeys}
          eventsByDate={eventsByDate}
          todayKey={todayKey}
        />
      )}
    </div>
  )
}
