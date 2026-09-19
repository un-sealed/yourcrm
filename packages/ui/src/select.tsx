import * as React from "react"
import { cn } from "./utils"

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  options?: SelectOption[]
  placeholder?: string
  invalid?: boolean
  className?: string
}

/**
 * Native select (no Radix select is installed in this workspace). Accepts
 * either `options` or `children` (`<option>` / `<optgroup>`).
 */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, placeholder, invalid = false, className, children, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      data-slot="select"
      aria-invalid={invalid || undefined}
      className={cn(
        "h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground shadow-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        invalid ? "border-destructive" : "border-input",
        className,
      )}
      {...props}
    >
      {placeholder !== undefined ? (
        <option value="" disabled={props.required === true || props.value === undefined}>
          {placeholder}
        </option>
      ) : null}
      {options !== undefined
        ? options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))
        : children}
    </select>
  )
})
