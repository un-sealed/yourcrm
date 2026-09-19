import * as React from "react"
import { Button } from "./button"
import { cn } from "./utils"

export interface ErrorStateProps extends React.HTMLAttributes<HTMLDivElement> {
  message: string
  onRetry?: () => void
  retryLabel?: string
  className?: string
}

/** Error placeholder with an optional retry callback. Exposed as an ARIA alert. */
export const ErrorState = React.forwardRef<HTMLDivElement, ErrorStateProps>(function ErrorState(
  { message, onRetry, retryLabel = "Try again", className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      role="alert"
      data-slot="error-state"
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className,
      )}
      {...props}
    >
      <p className="text-sm font-medium text-destructive">{message}</p>
      {onRetry !== undefined ? (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {retryLabel}
        </Button>
      ) : null}
    </div>
  )
})
