import * as React from "react"
import { cn } from "../utils"
import { chartSeriesVar, chartTokensCss } from "./chart-tokens"
import { abbreviateNumber, niceCeiling } from "./area-chart"

export interface BarChartDatum {
  label: string
  value: number
}

export interface BarChartProps {
  data: BarChartDatum[]
  highlightIndex?: number
  formatValue?: (value: number) => string
  className?: string
}

const VIEW_WIDTH = 600
const VIEW_HEIGHT = 260
const PAD_LEFT = 40
const PAD_RIGHT = 12
const PAD_TOP = 28
const PAD_BOTTOM = 28
const BAR_RADIUS = 4
const TICK_COUNT = 4
const TOOLTIP_WIDTH = 150
const TOOLTIP_HEIGHT = 64

/** Highlighted bar: series slot 1 (== brand in light, dark column in dark). */
const HIGHLIGHT_FILL = `var(${chartSeriesVar(0)})`
/** De-emphasis fill for the rest: `--border-strong` / `--surface-2`. */
const MUTED_FILL = "var(--chart-muted-bar)"

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** Index of the largest value (ties keep the first). Empty input -> 0. */
export function defaultHighlightIndex(data: BarChartDatum[]): number {
  let best = 0
  for (let index = 1; index < data.length; index += 1) {
    const current = data[index]
    const top = data[best]
    if (current !== undefined && top !== undefined && current.value > top.value) {
      best = index
    }
  }
  return best
}

/**
 * Bar column anchored to the baseline with 4px top rounding only
 * (an <rect rx> would round the baseline corners too).
 */
export function buildBarPath(
  x: number,
  topY: number,
  width: number,
  height: number,
  radius = BAR_RADIUS,
): string {
  const r = Math.max(0, Math.min(radius, width / 2, height))
  const left = round2(x)
  const right = round2(x + width)
  const top = round2(topY)
  const bottom = round2(topY + height)
  const shoulder = round2(topY + r)
  return (
    `M${left},${bottom} L${left},${shoulder} ` +
    `Q${left},${top} ${round2(x + r)},${top} ` +
    `L${round2(x + width - r)},${top} ` +
    `Q${right},${top} ${right},${shoulder} ` +
    `L${right},${bottom} Z`
  )
}

/**
 * Single-series bar chart (spec §3 BarChart). Hand-written SVG in a viewBox —
 * no fixed pixel widths, no chart library. One highlighted bar wears series
 * slot 1; every other bar is a de-emphasis (`--chart-muted-bar`, i.e.
 * `--border-strong` light / `--surface-2` dark) — not a second series, so no
 * legend. Bars are 4px top-rounded, anchored to the baseline, with a 2px gap.
 * The value label sits above the highlighted bar only; every bar owns a
 * hover tooltip. Hover is CSS-only (`group-hover`), no client state.
 */
export function BarChart({
  data,
  highlightIndex,
  formatValue = abbreviateNumber,
  className,
}: BarChartProps): React.ReactElement {
  if (data.length === 0) {
    return (
      <div data-slot="chart-empty" className={cn("w-full", className)}>
        <style>{chartTokensCss}</style>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          No data available.
        </p>
      </div>
    )
  }

  const highlighted = highlightIndex ?? defaultHighlightIndex(data)
  const plotWidth = VIEW_WIDTH - PAD_LEFT - PAD_RIGHT
  const plotHeight = VIEW_HEIGHT - PAD_TOP - PAD_BOTTOM
  const baselineY = PAD_TOP + plotHeight
  const maxValue = niceCeiling(Math.max(1, ...data.map((datum) => datum.value)))
  const bandWidth = plotWidth / data.length
  const barWidth = Math.max(2, bandWidth - 2)
  const ticks = Array.from(
    { length: TICK_COUNT },
    (_, index) => (maxValue / (TICK_COUNT - 1)) * index,
  )
  const stride = data.length > 8 ? Math.ceil(data.length / 8) : 1

  const barLeft = (index: number): number => PAD_LEFT + index * bandWidth + (bandWidth - barWidth) / 2
  const barHeight = (value: number): number => Math.max(0, (value / maxValue) * plotHeight)
  const tooltipX = (center: number): number =>
    Math.min(Math.max(center - TOOLTIP_WIDTH / 2, PAD_LEFT), VIEW_WIDTH - PAD_RIGHT - TOOLTIP_WIDTH)

  return (
    <div data-slot="bar-chart" className={cn("w-full", className)}>
      <style>{chartTokensCss}</style>
      <div className="relative w-full">
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          className="h-auto w-full"
          role="img"
          aria-label="bar chart"
        >
          {ticks.map((tick) => {
            const y = round2(PAD_TOP + plotHeight * (1 - tick / maxValue))
            return (
              <g key={tick}>
                <line
                  x1={PAD_LEFT}
                  x2={VIEW_WIDTH - PAD_RIGHT}
                  y1={y}
                  y2={y}
                  strokeWidth={1}
                  style={{ stroke: "var(--border)" }}
                />
                <text
                  x={PAD_LEFT - 8}
                  y={y + 4}
                  textAnchor="end"
                  fontSize={11}
                  style={{ fill: "var(--text-muted)" }}
                >
                  {abbreviateNumber(tick)}
                </text>
              </g>
            )
          })}
          {data.map((datum, index) => {
            const height = barHeight(datum.value)
            const left = barLeft(index)
            const top = baselineY - height
            const center = left + barWidth / 2
            const isHighlighted = index === highlighted
            return (
              <g
                key={`${datum.label}-${index}`}
                data-slot="bar-chart-bar"
                data-index={index}
                data-highlighted={isHighlighted}
                className="group"
              >
                <path
                  d={buildBarPath(left, top, barWidth, height)}
                  style={{ fill: isHighlighted ? HIGHLIGHT_FILL : MUTED_FILL }}
                />
                {isHighlighted ? (
                  <text
                    data-slot="bar-chart-highlight-label"
                    x={round2(center)}
                    y={round2(top - 8)}
                    textAnchor="middle"
                    fontSize={12}
                    fontWeight={600}
                    className="tabular-nums"
                    style={{ fill: "var(--text-primary)" }}
                  >
                    {formatValue(datum.value)}
                  </text>
                ) : null}
                <foreignObject
                  x={round2(tooltipX(center))}
                  y={8}
                  width={TOOLTIP_WIDTH}
                  height={TOOLTIP_HEIGHT}
                  style={{ pointerEvents: "none" }}
                >
                  <div
                    data-slot="bar-chart-tooltip"
                    data-index={index}
                    className="opacity-0 transition-opacity group-hover:opacity-100"
                    style={{
                      backgroundColor: "var(--surface-1)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-ctl)",
                      boxShadow: "var(--shadow-pop)",
                      padding: "8px 10px",
                    }}
                  >
                    <p className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>
                      {datum.label}
                    </p>
                    <p
                      className="mt-0.5 text-xs tabular-nums"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {formatValue(datum.value)}
                    </p>
                  </div>
                </foreignObject>
              </g>
            )
          })}
          {data.map((datum, index) =>
            index % stride === 0 || index === data.length - 1 ? (
              <text
                key={`x-${datum.label}-${index}`}
                x={round2(barLeft(index) + barWidth / 2)}
                y={baselineY + 18}
                textAnchor="middle"
                fontSize={11}
                style={{ fill: "var(--text-muted)" }}
              >
                {datum.label}
              </text>
            ) : null,
          )}
        </svg>
      </div>
    </div>
  )
}
