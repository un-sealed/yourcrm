import * as React from "react"
import { cn } from "../utils"

export interface StatTileDelta {
  value: string
  direction: "up" | "down"
}

export interface StatTileProps {
  label: string
  value: string
  delta?: StatTileDelta
  caption?: string
  icon?: React.ReactNode
  className?: string
}

/**
 * KPI tile (spec §3 StatTile). White card, 13px secondary label with an
 * outline icon top-right, 30px/600 tabular value, delta pill beside the
 * value (▲ + good tones for up, ▼ + bad tones for down — never colour
 * alone), 12px muted caption below. A bare tile ships no hover layer.
 */
export function StatTile({
  label,
  value,
  delta,
  caption,
  icon,
  className,
}: StatTileProps): React.ReactElement {
  const positive = delta?.direction === "up"
  return (
    <div
      data-slot="stat-tile"
      className={cn("w-full", className)}
      style={{
        backgroundColor: "var(--surface-1)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-card)",
        padding: "20px",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
          {label}
        </p>
        {icon !== undefined ? (
          <span aria-hidden="true" className="shrink-0" style={{ color: "var(--text-muted)" }}>
            {icon}
          </span>
        ) : null}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <p
          className="text-[30px] font-semibold tabular-nums"
          style={{ color: "var(--text-primary)", lineHeight: 1.2 }}
        >
          {value}
        </p>
        {delta !== undefined ? (
          <span
            data-slot="stat-tile-delta"
            data-direction={delta.direction}
            className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium"
            style={{
              borderRadius: "var(--radius-pill)",
              color: positive ? "var(--good)" : "var(--bad)",
              backgroundColor: positive ? "var(--good-soft)" : "var(--bad-soft)",
            }}
          >
            <span aria-hidden="true">{positive ? "▲" : "▼"}</span>
            {delta.value}
          </span>
        ) : null}
      </div>
      {caption !== undefined ? (
        <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
          {caption}
        </p>
      ) : null}
    </div>
  )
}
