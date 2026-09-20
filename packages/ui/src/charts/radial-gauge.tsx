import * as React from "react"
import { cn } from "../utils"

export interface RadialGaugeProps {
  value: number
  max?: number
  label?: string
  caption?: string
  /**
   * Formats the headline number. Without it the raw `value` is printed, which
   * is rarely what a gauge wants to show — a currency gauge would read
   * "146900" rather than "$146,900" or the attainment percentage.
   */
  formatValue?: (value: number) => string
  className?: string
}

export const GAUGE_TICK_COUNT = 60
export const GAUGE_START_DEG = 135
export const GAUGE_SWEEP_DEG = 270
const VIEWBOX_WIDTH = 200
const VIEWBOX_HEIGHT = 176
const CENTER_X = 100
const CENTER_Y = 88
const TICK_OUTER_R = 80
const TICK_INNER_R = 66

export interface GaugePoint {
  x: number
  y: number
}

/** Screen-space polar point (degrees, y down): 0° east, 90° south. */
export function polar(cx: number, cy: number, r: number, angleDeg: number): GaugePoint {
  const radians = (angleDeg * Math.PI) / 180
  return { x: cx + r * Math.cos(radians), y: cy + r * Math.sin(radians) }
}

/** Ticks lit for `value/max`, clamped to 0..total (degenerate ranges stay dark). */
export function filledTickCount(value: number, max: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || !(max > 0) || value <= 0) {
    return 0
  }
  if (value >= max) {
    return total
  }
  return Math.round((value / max) * total)
}

/**
 * Tick-mark gauge (spec §3 RadialGauge). 270° arc of discrete 2px ticks over
 * a bottom gap; lit ticks wear `--good`, the rest `--border`. Centre shows
 * the value at 32px/600 with the caption below in `--text-muted`. A single
 * value ⇒ no legend and no hover layer.
 */
export function RadialGauge({
  value,
  max = 100,
  label,
  caption,
  formatValue,
  className,
}: RadialGaugeProps) {
  const headline = formatValue ? formatValue(value) : String(value)
  const filled = filledTickCount(value, max, GAUGE_TICK_COUNT)
  const step = GAUGE_SWEEP_DEG / Math.max(1, GAUGE_TICK_COUNT - 1)
  return (
    <div data-slot="radial-gauge" className={cn("w-full", className)}>
      <svg
        viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
        role="img"
        aria-label={`${label ?? "Gauge"}: ${headline} of ${max}`}
        className="h-auto w-full"
      >
        <title>{`${label ?? "Gauge"}: ${headline} of ${max}`}</title>
        {Array.from({ length: GAUGE_TICK_COUNT }, (_, index) => {
          const angle = GAUGE_START_DEG + index * step
          const outer = polar(CENTER_X, CENTER_Y, TICK_OUTER_R, angle)
          const inner = polar(CENTER_X, CENTER_Y, TICK_INNER_R, angle)
          return (
            <line
              key={index}
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
              strokeWidth={2}
              strokeLinecap="round"
              style={{ stroke: index < filled ? "var(--good)" : "var(--border)" }}
            />
          )
        })}
        {label === undefined ? null : (
          <text
            x={CENTER_X}
            y={CENTER_Y - 26}
            textAnchor="middle"
            fontSize={13}
            style={{ fill: "var(--text-secondary)" }}
          >
            {label}
          </text>
        )}
        <text
          x={CENTER_X}
          y={CENTER_Y + 10}
          textAnchor="middle"
          fontSize={32}
          fontWeight={600}
          className="tabular-nums"
          style={{ fill: "var(--text-primary)" }}
        >
          {headline}
        </text>
      </svg>
      {caption === undefined ? null : (
        <p className="mt-1 text-center text-xs text-[var(--text-muted)]">{caption}</p>
      )}
    </div>
  )
}
