import * as React from "react"
import { Avatar } from "./avatar"
import { Badge, type BadgeTone } from "./badge"
import { cn } from "./utils"

export interface RecordHeaderStatus {
  label: string
  tone?: BadgeTone
}

export interface RecordHeaderOwner {
  name: string
  src?: string
}

export interface RecordHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  title: React.ReactNode
  subtitle?: React.ReactNode
  status?: RecordHeaderStatus
  owner?: RecordHeaderOwner
  actions?: React.ReactNode
  className?: string
}

/** Title block for record pages: title, subtitle, status badge, owner, actions. */
export const RecordHeader = React.forwardRef<HTMLElement, RecordHeaderProps>(function RecordHeader(
  { title, subtitle, status, owner, actions, className, ...props },
  ref,
) {
  return (
    <header
      ref={ref}
      data-slot="record-header"
      className={cn("flex flex-wrap items-start justify-between gap-3", className)}
      {...props}
    >
      <div className="flex min-w-0 items-start gap-3">
        {owner !== undefined ? <Avatar name={owner.name} src={owner.src} size="lg" /> : null}
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold text-foreground">
              {title}
            </h1>
            {status !== undefined ? (
              <Badge tone={status.tone ?? "secondary"}>{status.label}</Badge>
            ) : null}
          </div>
          {subtitle !== undefined && subtitle !== null ? (
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          ) : null}
          {owner !== undefined ? (
            <p className="text-xs text-muted-foreground">Owner: {owner.name}</p>
          ) : null}
        </div>
      </div>
      {actions !== undefined && actions !== null ? (
        <div className="flex items-center gap-2">{actions}</div>
      ) : null}
    </header>
  )
})
