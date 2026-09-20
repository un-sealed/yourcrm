import * as React from "react"
import { cn } from "../utils"

export type StatTileDeltaDirection = "up" | "down"

export interface StatTileDelta {
  value: string
  direction: StatTileDeltaDirection
}

export interface StatTileProps {
  label: string
  value: string
  delta?: StatTileDelta
  caption?: string
  icon?: React.ReactNode
  className?: string
}

const DELTA_GLYPH: Record<StatTileDeltaDirection, string> = { up: "▲", down: "▼" }

/**
 * KPI tile (spec §3 StatTile). White card, 30px/600 tabular value, delta pill
 * beside it, muted caption below. A bare tile has no hover layer — nothing
 * to hover — so this renders no pointer handlers by design.
 */
export function StatTile({ label, value, delta, caption, icon, className }: StatTileProps) {
  const positive = delta?.direction === "up"
  return (
    <div
      data-slot="stat-tile"
      className={cn("flex flex-col gap-1 p-5", className)}
      style={{
        backgroundColor: "var(--surface-1)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
          {label}
        </p>
        {icon === undefined ? null : (
          <span aria-hidden="true" className="shrink-0" style={{ color: "var(--text-muted)" }}>
            {icon}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <p
          data-slot="stat-tile-value"
          className="text-[30px] font-semibold leading-none tabular-nums"
          style={{ color: "var(--text-primary)" }}
        >
          {value}
        </p>
        {delta === undefined ? null : (
          <span
            data-slot="stat-tile-delta"
            data-direction={delta.direction}
            className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium tabular-nums"
            style={{
              borderRadius: "var(--radius-pill)",
              color: positive ? "var(--good)" : "var(--bad)",
              backgroundColor: positive ? "var(--good-soft)" : "var(--bad-soft)",
            }}
          >
            <span aria-hidden="true">{DELTA_GLYPH[delta.direction]}</span>
            {delta.value}
          </span>
        )}
      </div>
      {caption === undefined ? null : (
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          {caption}
        </p>
      )}
    </div>
  )
}
