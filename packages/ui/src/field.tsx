import * as React from "react"
import { cn } from "./utils"

export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  label: React.ReactNode
  htmlFor?: string
  hint?: React.ReactNode
  error?: React.ReactNode
  required?: boolean
  className?: string
  children?: React.ReactNode
}

/**
 * Label + control wrapper shared by every form field. Associates the label,
 * exposes hint/error text via `aria-describedby` when ids are provided by the
 * control, and marks required fields with text (never color alone).
 */
export const Field = React.forwardRef<HTMLDivElement, FieldProps>(function Field(
  { label, htmlFor, hint, error, required = false, className, children, ...props },
  ref,
) {
  const hintId = hint !== undefined && hint !== null ? `${htmlFor ?? "field"}-hint` : undefined
  const errorId = error !== undefined && error !== null ? `${htmlFor ?? "field"}-error` : undefined
  const describedBy = [hintId, errorId].filter((id) => id !== undefined).join(" ") || undefined
  return (
    <div ref={ref} data-slot="field" className={cn("flex flex-col gap-1.5", className)} {...props}>
      <label
        htmlFor={htmlFor}
        className="text-sm font-medium text-foreground"
        aria-describedby={describedBy}
      >
        {label}
        {required ? (
          <span aria-hidden="true" className="ml-1 text-destructive">
            *
          </span>
        ) : null}
        {required ? <span className="sr-only">(required)</span> : null}
      </label>
      {children}
      {hint !== undefined && hint !== null ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error !== undefined && error !== null ? (
        <p id={errorId} role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
})
