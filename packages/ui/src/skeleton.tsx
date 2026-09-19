import * as React from "react"
import { cn } from "./utils"

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string
}

/** Placeholder block shown while content loads. shadcn/ui convention. */
export const Skeleton = React.forwardRef<HTMLDivElement, SkeletonProps>(function Skeleton(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  )
})
