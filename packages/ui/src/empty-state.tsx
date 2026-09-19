import * as React from "react"
import { cn } from "./utils"

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
}

/** Centered empty-collection placeholder with optional icon and action slot. */
export const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  { icon, title, description, action, className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-6 py-12 text-center",
        className,
      )}
      {...props}
    >
      {icon !== undefined && icon !== null ? (
        <div
          className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-xs"
          aria-hidden="true"
        >
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {description !== undefined && description !== null ? (
        <div className="max-w-sm text-sm text-muted-foreground">{description}</div>
      ) : null}
      {action !== undefined && action !== null ? <div className="mt-2">{action}</div> : null}
    </div>
  )
})
