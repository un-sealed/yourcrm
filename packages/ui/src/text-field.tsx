import * as React from "react"
import { cn } from "./utils"

export interface TextFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  className?: string
  invalid?: boolean
}

/** Single-line text input. Pair with `Field` for label/hint/error. */
export const TextField = React.forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { className, invalid = false, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      data-slot="text-field"
      aria-invalid={invalid || undefined}
      className={cn(
        "h-9 w-full rounded-lg border bg-card px-3 text-sm text-foreground shadow-xs transition-colors",
        "placeholder:text-muted-foreground",
        "focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40",
        "disabled:cursor-not-allowed disabled:opacity-50",
        invalid ? "border-destructive" : "border-input",
        className,
      )}
      {...props}
    />
  )
})
