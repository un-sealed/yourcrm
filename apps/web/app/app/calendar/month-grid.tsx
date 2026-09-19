import Link from "next/link"
import { cn } from "@yourcrm/ui"
import { dayOfKey, isInMonth } from "./calendar-math"

export type MonthGridEvent = {
  id: string
  title: string
  allDay: boolean
  /** `"HH:mm"` in the workspace timezone, or `null` for all-day events. */
  time: string | null
}

export type MonthGridProps = {
  year: number
  month: number
  /** 42 `"YYYY-MM-DD"` keys from `buildMonthGrid`. */
  gridKeys: string[]
  /** Events bucketed by workspace-local calendar day (`localCalendarDateKey`). */
  eventsByDate: Record<string, MonthGridEvent[]>
  /** Workspace-local `"YYYY-MM-DD"` for today's highlight, or `null`. */
  todayKey: string | null
  maxEventsPerCell?: number
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/**
 * Month-grid layout — the one UI primitive this module builds itself (no
 * `@yourcrm/ui` component covers a calendar grid). Everything else (cells'
 * content, buttons, empty/loading/error states) reuses shared primitives.
 *
 * Pure presentation: date-key -> events bucketing happens in the page
 * component using `@yourcrm/crm/src/calendar/timezone`'s
 * `localCalendarDateKey`, so this component never touches `Date` math
 * beyond what `./calendar-math` already resolved into keys.
 */
export function MonthGrid({
  year,
  month,
  gridKeys,
  eventsByDate,
  todayKey,
  maxEventsPerCell = 3,
}: MonthGridProps) {
  return (
    <div className="flex flex-col gap-px overflow-hidden rounded-md border border-border bg-border">
      <div className="grid grid-cols-7 gap-px bg-border" role="row">
        {WEEKDAY_LABELS.map((label) => (
          <div
            key={label}
            role="columnheader"
            className="bg-muted px-2 py-1 text-center text-xs font-medium text-muted-foreground"
          >
            {label}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 grid-rows-6 gap-px bg-border" role="grid" aria-label="Month">
        {gridKeys.map((key) => {
          const inMonth = isInMonth(key, year, month)
          const events = eventsByDate[key] ?? []
          const visible = events.slice(0, maxEventsPerCell)
          const overflow = events.length - visible.length
          const isToday = key === todayKey
          return (
            <div
              key={key}
              role="gridcell"
              aria-current={isToday ? "date" : undefined}
              className={cn(
                "flex min-h-24 flex-col gap-1 bg-background p-1.5",
                !inMonth && "bg-muted/40 text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "self-start rounded-full px-1.5 text-xs font-medium",
                  isToday && "bg-primary text-primary-foreground",
                )}
              >
                {dayOfKey(key)}
              </span>
              <div className="flex flex-col gap-0.5">
                {visible.map((event) => (
                  <Link
                    key={event.id}
                    href={`/app/calendar/${event.id}`}
                    className="truncate rounded bg-primary/10 px-1 py-0.5 text-xs text-primary hover:bg-primary/20"
                    title={event.title}
                  >
                    {event.allDay ? event.title : `${event.time} ${event.title}`}
                  </Link>
                ))}
                {overflow > 0 ? (
                  <Link
                    href={`/app/calendar/agenda?date=${key}`}
                    className="px-1 text-xs text-muted-foreground hover:underline"
                  >
                    +{overflow} more
                  </Link>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
