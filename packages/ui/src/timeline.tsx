import * as React from "react"
import { cn } from "./utils"

export interface TimelineItem {
  id: string
  icon?: React.ReactNode
  actor?: string
  /** Human-readable timestamp label, e.g. "2h ago" or "Mar 4, 2026". */
  timestamp: string
  /** Machine-readable timestamp for the `<time>` element. */
  dateTime?: string
  body: React.ReactNode
}

export interface TimelineProps extends React.HTMLAttributes<HTMLOListElement> {
  items: TimelineItem[]
  className?: string
}

/** Ordered activity feed: icon, actor, timestamp, body slot per item. */
export const Timeline = React.forwardRef<HTMLOListElement, TimelineProps>(function Timeline(
  { items, className, ...props },
  ref,
) {
  return (
    <ol ref={ref} data-slot="timeline" className={cn("flex flex-col gap-4", className)} {...props}>
      {items.map((item) => (
        <li key={item.id} data-slot="timeline-item" className="flex gap-3">
          {item.icon !== undefined && item.icon !== null ? (
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-secondary-foreground"
            >
              {item.icon}
            </span>
          ) : (
            <span aria-hidden="true" className="mt-2 h-2 w-2 shrink-0 rounded-full bg-border" />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
              {item.actor !== undefined ? (
                <span className="text-sm font-medium text-foreground">{item.actor}</span>
              ) : null}
              <time dateTime={item.dateTime} className="text-xs text-muted-foreground">
                {item.timestamp}
              </time>
            </div>
            <div className="text-sm text-foreground">{item.body}</div>
          </div>
        </li>
      ))}
    </ol>
  )
})
