import * as React from "react"
import { cn } from "./utils"

export interface CheckboxProps extends React.InputHTMLAttributes<HTMLInputElement> {
  indeterminate?: boolean
  className?: string
}

function setCheckboxRefs(
  node: HTMLInputElement | null,
  indeterminate: boolean | undefined,
  forwarded: React.ForwardedRef<HTMLInputElement>,
): void {
  if (node !== null && indeterminate !== undefined) {
    node.indeterminate = indeterminate
  }
  if (typeof forwarded === "function") {
    forwarded(node)
  } else if (forwarded !== null && typeof forwarded === "object") {
    ;(forwarded as React.MutableRefObject<HTMLInputElement | null>).current = node
  }
}

/** Native checkbox with shadcn-style visuals. Supports `indeterminate`. */
export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { indeterminate, className, ...props },
  ref,
) {
  return (
    <input
      ref={(node) => setCheckboxRefs(node, indeterminate, ref)}
      type="checkbox"
      data-slot="checkbox"
      aria-checked={indeterminate === true ? "mixed" : undefined}
      className={cn(
        "h-4 w-4 shrink-0 rounded-[5px] border border-input bg-card shadow-xs transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "checked:border-primary checked:bg-primary",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  )
})
