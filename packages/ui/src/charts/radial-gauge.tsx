import * as React from "react"
import { cn } from "../utils"

export interface RadialGaugeTick {
  x1: number
  y1: number
  x2: number
  y2: number
  filled: boolean
}

export interface RadialGaugeProps {
  value: number
  max?: number
  label?: string
  caption?: string
  className?: string
}

const TICK_COUNT = 60
const SWEEP_DEGREES = 270
const START_DEGREES = 135
const CENTER_X = 100
const CENTER_Y = 100
const TICK_OUTER = 84
const TICK_INNER = 72

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** Ticks lit for `value`/`max`, clamped to [0, count]. Non-finite input -> 0. */
export function filledTickCount(value: number, max: number, count = TICK_COUNT): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) {
    return 0
  }
  const ratio = Math.min(Math.max(value, 0), max) / max
  return Math.max(0, Math.min(count, Math.round(ratio * count)))
}

/**
 * ~60 discrete 2px ticks on a 270° arc (gap at the bottom). Filled ticks
 * wear `--good`, the remainder `--border`. Pure geometry — testable without
 * a renderer.
 */
export function buildGaugeTicks(
  value: number,
  max: number,
  count = TICK_COUNT,
): RadialGaugeTick[] {
  const filled = filledTickCount(value, max, count)
  return Array.from({ length: count }, (_, index) => {
    const angle = ((START_DEGREES + (SWEEP_DEGREES / count) * (index + 0.5)) * Math.PI) / 180
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    return {
      x1: round2(CENTER_X + TICK_OUTER * cos),
      y1: round2(CENTER_Y + TICK_OUTER * sin),
      x2: round2(CENTER_X + TICK_INNER * cos),
      y2: round2(CENTER_Y + TICK_INNER * sin),
      filled: index < filled,
    }
  })
}

/**
 * Tick-mark radial gauge (spec §3 RadialGauge). 270° arc of ~60 discrete
 * 2px ticks, filled `--good` up to `value`/`max`, remainder `--border`.
 * Centre value 32px/600 tabular, caption below in muted. Single value ⇒ no
 * legend, no hover layer. viewBox-based SVG renders into the parent width.
 */
export function RadialGauge({
  value,
  max = 100,
  label,
  caption,
  className,
}: RadialGaugeProps): React.ReactElement {
  const ticks = buildGaugeTicks(value, max)
  return (
    <div data-slot="radial-gauge" className={cn("w-full", className)}>
      {label !== undefined ? (
        <p
          data-slot="radial-gauge-label"
          className="text-center text-[13px]"
          style={{ color: "var(--text-secondary)" }}
        >
          {label}
        </p>
      ) : null}
      <svg
        viewBox="0 0 200 150"
        className="h-auto w-full"
        role="img"
        aria-label={`${label ?? "Gauge"}: ${value} of ${max}`}
      >
        {ticks.map((tick, index) => (
          <line
            key={index}
            data-slot="radial-gauge-tick"
            data-filled={tick.filled}
            x1={tick.x1}
            y1={tick.y1}
            x2={tick.x2}
            y2={tick.y2}
            strokeWidth={2}
            strokeLinecap="round"
            style={{ stroke: tick.filled ? "var(--good)" : "var(--border)" }}
          />
        ))}
        <text
          data-slot="radial-gauge-value"
          x={CENTER_X}
          y={112}
          textAnchor="middle"
          fontSize={32}
          fontWeight={600}
          className="tabular-nums"
          style={{ fill: "var(--text-primary)" }}
        >
          {value}
        </text>
        {caption !== undefined ? (
          <text
            data-slot="radial-gauge-caption"
            x={CENTER_X}
            y={134}
            textAnchor="middle"
            fontSize={12}
            style={{ fill: "var(--text-muted)" }}
          >
            {caption}
          </text>
        ) : null}
      </svg>
    </div>
  )
}
