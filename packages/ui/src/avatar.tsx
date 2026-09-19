import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "./utils"

const avatarVariants = cva(
  "inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-secondary font-medium text-secondary-foreground ring-1 ring-border",
  {
    variants: {
      size: {
        sm: "h-6 w-6 text-[11px]",
        md: "h-8 w-8 text-xs",
        lg: "h-10 w-10 text-sm",
      },
    },
    defaultVariants: { size: "md" },
  },
)

/** Derive up-to-two-letter initials from a display name. */
export function getInitials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0)
  if (parts.length === 0) {
    return "?"
  }
  const first = parts[0] as string
  const last = parts.length > 1 ? (parts[parts.length - 1] as string) : null
  const letters = last !== null ? `${first[0] ?? ""}${last[0] ?? ""}` : (first.slice(0, 2) ?? "")
  return letters.toUpperCase() || "?"
}

export interface AvatarProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof avatarVariants> {
  name?: string
  src?: string
  alt?: string
  className?: string
}

/** Person/company avatar with an initials fallback when no image loads. */
export const Avatar = React.forwardRef<HTMLDivElement, AvatarProps>(function Avatar(
  { name = "", src, alt, size, className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-slot="avatar"
      role="img"
      aria-label={alt ?? name}
      title={name || undefined}
      className={cn(avatarVariants({ size }), className)}
      {...props}
    >
      {src !== undefined && src !== "" ? (
        <img src={src} alt={alt ?? name} className="h-full w-full object-cover" />
      ) : (
        <span aria-hidden="true">{getInitials(name)}</span>
      )}
    </div>
  )
})
