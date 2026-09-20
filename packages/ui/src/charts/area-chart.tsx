import * as React from "react"
import { cn } from "../utils"
import { chartSeriesVar, chartTokensCss } from "./chart-tokens"

export interface AreaChartDatum {
  label: string
  value: number
  compare?: number
}

export interface AreaChartProps {
  data: AreaChartDatum[]
  series: string
  compareSeries?: string
  formatValue?: (value: number) => string
  className?: string
}

export interface AreaPoint {
  x: number
  y: number
}

const VIEW_WIDTH = 600
const VIEW_HEIGHT = 260
const PAD_LEFT = 40
const PAD_RIGHT = 64
const PAD_TOP = 16
const PAD_BOTTOM = 28
const TICK_COUNT = 4
const TOOLTIP_WIDTH = 172
const TOOLTIP_HEIGHT = 92

/** Series-1 as a CSS var reference (dark column resolves via `.dark`). */
const CURRENT_SERIES = `var(${chartSeriesVar(0)})`

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** Abbreviate axis/hover numbers: 5000 -> "5K", 10500 -> "10K", 900 -> "900". */
export function abbreviateNumber(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1000) {
    const trimmed = Number((value / 1000).toFixed(abs >= 10000 ? 0 : 1))
    return `${trimmed}K`
  }
  return String(Math.round(value))
}

/** Round a data max up to a 1/2/2.5/5/10 step so ticks land on round values. */
export function niceCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 1
  }
  const base = 10 ** Math.floor(Math.log10(value))
  const fraction = value / base
  const nice =
    fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10
  return nice * base
}

/** Open polyline through plot points. */
export function buildLinePath(points: AreaPoint[]): string {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${round2(point.x)},${round2(point.y)}`)
    .join(" ")
}

/** Area fill: line path closed down to the baseline. Empty input -> "". */
export function buildFillPath(points: AreaPoint[], baselineY: number): string {
  const first = points[0]
  const last = points[points.length - 1]
  if (first === undefined || last === undefined) {
    return ""
  }
  const baseline = round2(baselineY)
  return `${buildLinePath(points)} L${round2(last.x)},${baseline} L${round2(first.x)},${baseline} Z`
}

/** Hover lookup: the datum shown in the tooltip for a hovered point index. */
export function resolveHoverDatum(
  data: AreaChartDatum[],
  index: number,
): AreaChartDatum | undefined {
  return data[index]
}

let areaChartCounter = 0

/**
 * Two-series area chart (spec §3 AreaChart). Hand-written SVG in a viewBox so
 * it renders into the parent width — no fixed pixel widths, no chart library.
 * 2px series-1 line with an 18%→0% fill, 1.5px dashed muted comparison line
 * with no fill, horizontal 1px gridlines only, 11px muted axis text, no axis
 * lines. Two series ⇒ legend plus a direct label on the current series end.
 * Hover (mandatory): each point owns a full-plot-height hit rect showing a
 * vertical crosshair, an end dot and a tooltip card with both values, each
 * with its colour swatch. Hover is CSS-only (`group-hover`) so it works
 * without client state.
 */
export function AreaChart({
  data,
  series,
  compareSeries,
  formatValue = abbreviateNumber,
  className,
}: AreaChartProps): React.ReactElement {
  areaChartCounter += 1
  const gradientId = `area-fill-${areaChartCounter}`

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

  const plotWidth = VIEW_WIDTH - PAD_LEFT - PAD_RIGHT
  const plotHeight = VIEW_HEIGHT - PAD_TOP - PAD_BOTTOM
  const baselineY = PAD_TOP + plotHeight
  const maxValue = niceCeiling(
    Math.max(1, ...data.flatMap((datum) => [datum.value, datum.compare ?? datum.value])),
  )
  const hasCompare = compareSeries !== undefined && data.some((datum) => datum.compare !== undefined)

  const xOf = (index: number): number =>
    data.length === 1
      ? PAD_LEFT + plotWidth / 2
      : PAD_LEFT + (index / (data.length - 1)) * plotWidth
  const yOf = (value: number): number => PAD_TOP + plotHeight * (1 - value / maxValue)

  const current: AreaPoint[] = data.map((datum, index) => ({ x: xOf(index), y: yOf(datum.value) }))
  const comparison: AreaPoint[] = data.map((datum, index) => ({
    x: xOf(index),
    y: yOf(datum.compare ?? datum.value),
  }))
  const ticks = Array.from(
    { length: TICK_COUNT },
    (_, index) => (maxValue / (TICK_COUNT - 1)) * index,
  )
  const stride = Math.max(1, Math.ceil(data.length / 6))
  const bandWidth = plotWidth / data.length
  const last = current[current.length - 1] as AreaPoint

  const tooltipX = (x: number): number =>
    Math.min(Math.max(x - TOOLTIP_WIDTH / 2, PAD_LEFT), VIEW_WIDTH - PAD_RIGHT - TOOLTIP_WIDTH)

  return (
    <div data-slot="area-chart" className={cn("w-full", className)}>
      <style>{chartTokensCss}</style>
      <div data-slot="area-chart-legend" className="mb-2 flex flex-wrap items-center gap-4 text-xs">
        <span className="inline-flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
          <span
            aria-hidden="true"
            className="inline-block h-[2px] w-4 rounded-full"
            style={{ backgroundColor: CURRENT_SERIES }}
          />
          {series}
        </span>
        {hasCompare ? (
          <span className="inline-flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
            <span
              aria-hidden="true"
              className="inline-block w-4 border-t-2 border-dashed"
              style={{ borderColor: "var(--text-muted)" }}
            />
            {compareSeries}
          </span>
        ) : null}
      </div>
      <div className="relative w-full">
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          className="h-auto w-full"
          role="img"
          aria-label={`${series}${hasCompare ? ` vs ${compareSeries}` : ""} area chart`}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: CURRENT_SERIES, stopOpacity: 0.18 }} />
              <stop offset="100%" style={{ stopColor: CURRENT_SERIES, stopOpacity: 0 }} />
            </linearGradient>
          </defs>
          {ticks.map((tick) => {
            const y = round2(yOf(tick))
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
          {hasCompare ? (
            <path
              d={buildLinePath(comparison)}
              fill="none"
              strokeWidth={1.5}
              strokeDasharray="5 4"
              style={{ stroke: "var(--text-muted)" }}
            />
          ) : null}
          <path d={buildFillPath(current, baselineY)} fill={`url(#${gradientId})`} />
          <path
            d={buildLinePath(current)}
            fill="none"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            style={{ stroke: CURRENT_SERIES }}
          />
          <text x={last.x + 8} y={last.y + 4} fontSize={11} style={{ fill: "var(--text-secondary)" }}>
            {series}
          </text>
          {data.map((datum, index) => {
            const point = current[index] as AreaPoint
            return (
              <g key={`${datum.label}-${index}`} className="group">
                <line
                  x1={round2(point.x)}
                  x2={round2(point.x)}
                  y1={PAD_TOP}
                  y2={baselineY}
                  strokeWidth={1}
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                  style={{ stroke: "var(--border-strong)" }}
                />
                <rect
                  x={Math.max(PAD_LEFT, round2(point.x - bandWidth / 2))}
                  y={PAD_TOP}
                  width={round2(Math.min(bandWidth, VIEW_WIDTH - PAD_RIGHT - point.x + bandWidth / 2))}
                  height={plotHeight}
                  fill="transparent"
                />
                <circle
                  cx={round2(point.x)}
                  cy={round2(point.y)}
                  r={3.5}
                  strokeWidth={2}
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                  style={{ fill: CURRENT_SERIES, stroke: "var(--surface-1)" }}
                />
                <foreignObject
                  x={round2(tooltipX(point.x))}
                  y={8}
                  width={TOOLTIP_WIDTH}
                  height={TOOLTIP_HEIGHT}
                  style={{ pointerEvents: "none" }}
                >
                  <div
                    data-slot="area-chart-tooltip"
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
                      className="mt-1 flex items-center gap-1.5 text-xs tabular-nums"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      <span
                        aria-hidden="true"
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ backgroundColor: CURRENT_SERIES }}
                      />
                      {series}: {formatValue(datum.value)}
                    </p>
                    {hasCompare && datum.compare !== undefined ? (
                      <p
                        className="mt-0.5 flex items-center gap-1.5 text-xs tabular-nums"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        <span
                          aria-hidden="true"
                          className="inline-block h-2 w-2 rounded-full"
                          style={{ backgroundColor: "var(--text-muted)" }}
                        />
                        {compareSeries}: {formatValue(datum.compare)}
                      </p>
                    ) : null}
                  </div>
                </foreignObject>
              </g>
            )
          })}
          {data.map((datum, index) =>
            index % stride === 0 || index === data.length - 1 ? (
              <text
                key={`x-${datum.label}-${index}`}
                x={round2(xOf(index))}
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
