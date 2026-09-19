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
    <ol ref={ref} data-slot="timeline" className={cn("flex flex-col", className)} {...props}>
      {items.map((item, index) => {
        const isLast = index === items.length - 1
        return (
          <li
            key={item.id}
            data-slot="timeline-item"
            className={cn("relative flex gap-3", !isLast && "pb-5")}
          >
            <span aria-hidden="true" className="relative flex w-8 shrink-0 justify-center">
              {!isLast ? (
                <span className="absolute bottom-[-0.25rem] top-8 w-px bg-border" />
              ) : null}
              {item.icon !== undefined && item.icon !== null ? (
                <span className="z-10 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-xs">
                  {item.icon}
                </span>
              ) : (
                <span className="z-10 mt-3 h-2.5 w-2.5 rounded-full border border-border bg-muted" />
              )}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-1">
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
        )
      })}
    </ol>
  )
})
