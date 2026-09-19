import * as React from "react"
import { Button } from "./button"
import { cn } from "./utils"

export interface BulkBarProps extends React.HTMLAttributes<HTMLDivElement> {
  selectedCount: number
  onClear?: () => void
  clearLabel?: string
  children?: React.ReactNode
  className?: string
}

/**
 * Floating action bar for bulk operations. Renders nothing when
 * `selectedCount` is zero; `children` is the actions slot.
 */
export const BulkBar = React.forwardRef<HTMLDivElement, BulkBarProps>(function BulkBar(
  { selectedCount, onClear, clearLabel = "Clear selection", children, className, ...props },
  ref,
) {
  if (selectedCount <= 0) {
    return null
  }
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={`Bulk actions for ${selectedCount} selected`}
      data-slot="bulk-bar"
      className={cn(
        "fixed bottom-4 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 shadow-lg",
        className,
      )}
      {...props}
    >
      <span aria-live="polite" className="whitespace-nowrap text-sm font-medium text-foreground">
        {selectedCount} selected
      </span>
      <span aria-hidden="true" className="h-5 w-px bg-border" />
      <span className="flex items-center gap-1">{children}</span>
      {onClear !== undefined ? (
        <Button type="button" variant="ghost" size="sm" onClick={onClear} aria-label={clearLabel}>
          ✕
        </Button>
      ) : null}
    </div>
  )
})
