import * as React from "react"
import { cn } from "./utils"

export interface DatePickerProps extends React.InputHTMLAttributes<HTMLInputElement> {
  className?: string
  invalid?: boolean
}

/**
 * Date picker built on the native date input (no date-picker dependency is
 * installed in this workspace). Controlled via `value` (`YYYY-MM-DD`).
 */
export const DatePicker = React.forwardRef<HTMLInputElement, DatePickerProps>(function DatePicker(
  { className, invalid = false, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type="date"
      data-slot="date-picker"
      aria-invalid={invalid || undefined}
      className={cn(
        "h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground shadow-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "dark:[color-scheme:dark]",
        invalid ? "border-destructive" : "border-input",
        className,
      )}
      {...props}
    />
  )
})
