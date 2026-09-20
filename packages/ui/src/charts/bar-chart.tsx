import * as React from "react"
import { areaYticks, formatCompactNumber } from "./area-chart"
import { chartTokensCss } from "./chart-tokens"
import { cn } from "../utils"

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

export const BAR_VIEWBOX_WIDTH = 720
export const BAR_VIEWBOX_HEIGHT = 280
const PLOT_LEFT = 40
const PLOT_RIGHT_GUTTER = 16
const PLOT_TOP = 28
const PLOT_BOTTOM_GUTTER = 24
const BAR_GAP = 2
const BAR_RADIUS = 4

const plotWidth = BAR_VIEWBOX_WIDTH - PLOT_LEFT - PLOT_RIGHT_GUTTER
const plotHeight = BAR_VIEWBOX_HEIGHT - PLOT_TOP - PLOT_BOTTOM_GUTTER
const plotBottom = PLOT_TOP + plotHeight
const plotRight = PLOT_LEFT + plotWidth

/** First index holding the maximum value; -1 for empty data. */
export function defaultHighlightIndex(data: BarChartDatum[]): number {
  let best = -1
  for (let index = 0; index < data.length; index += 1) {
    const datum = data[index] as BarChartDatum
    const current = best < 0 ? undefined : (data[best] as BarChartDatum)
    if (current === undefined || datum.value > current.value) {
      best = index
    }
  }
  return best
}

/** Explicit highlight when in range, otherwise the max-value default. */
export function resolveHighlightIndex(data: BarChartDatum[], highlightIndex?: number): number {
  if (
    highlightIndex !== undefined &&
    Number.isInteger(highlightIndex) &&
    highlightIndex >= 0 &&
    highlightIndex < data.length
  ) {
    return highlightIndex
  }
  return defaultHighlightIndex(data)
}

/**
 * Top-rounded bar path anchored to the baseline (`yb`). Empty string for
 * non-positive heights so zero values leave no floating mark.
 */
export function barPath(x: number, yTop: number, w: number, h: number, yb: number): string {
  if (!(h > 0) || !(w > 0)) {
    return ""
  }
  const r = Math.min(BAR_RADIUS, w / 2, h)
  const yt = yTop
  const f = (n: number): string => n.toFixed(2)
  return (
    `M${f(x)},${f(yb)}L${f(x)},${f(yt + r)}` +
    `Q${f(x)},${f(yt)}${f(x + r)},${f(yt)}` +
    `L${f(x + w - r)},${f(yt)}` +
    `Q${f(x + w)},${f(yt)}${f(x + w)},${f(yt + r)}` +
    `L${f(x + w)},${f(yb)}Z`
  )
}

/** Datum shown in the per-bar tooltip; `null` out of range. */
export function getBarHoverDatum(data: BarChartDatum[], index: number): BarChartDatum | null {
  if (!Number.isInteger(index) || index < 0 || index >= data.length) {
    return null
  }
  return data[index] as BarChartDatum
}

function defaultFormatValue(value: number): string {
  return value.toLocaleString("en-US")
}

/**
 * Single-series bar chart (spec §3 BarChart). The highlighted bar wears
 * `--brand`; the rest are de-emphasised `--border-strong`
 * (`--surface-2` in dark) — not a second series, so no legend. Bars are
 * 4px top-rounded, baseline-anchored, 2px apart; the value label sits above
 * the highlighted bar only. Each bar carries its own hover tooltip.
 */
export function BarChart({ data, highlightIndex, formatValue, className }: BarChartProps) {
  const format = formatValue ?? defaultFormatValue
  if (data.length === 0) {
    return (
      <div
        data-slot="bar-chart"
        className={cn("flex h-40 items-center justify-center text-sm", className)}
        style={{ color: "var(--text-muted)" }}
      >
        No data available
      </div>
    )
  }

  const highlighted = resolveHighlightIndex(data, highlightIndex)
  const maxValue = Math.max(0, ...data.map((datum) => datum.value))
  const ticks = areaYticks(maxValue)
  const top = ticks[ticks.length - 1] as number
  const span = top === 0 ? 1 : top

  const barW = (plotWidth - BAR_GAP * (data.length - 1)) / data.length
  const x = (index: number): number => PLOT_LEFT + index * (barW + BAR_GAP)
  const y = (value: number): number => PLOT_TOP + plotHeight * (1 - Math.max(0, value) / span)

  return (
    <div data-slot="bar-chart" className={cn("w-full", className)}>
      <style>{chartTokensCss()}</style>
      <svg
        viewBox={`0 0 ${BAR_VIEWBOX_WIDTH} ${BAR_VIEWBOX_HEIGHT}`}
        role="img"
        aria-label="Bar chart"
        className="h-auto w-full"
      >
        <title>Bar chart</title>
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PLOT_LEFT}
              x2={plotRight}
              y1={y(tick)}
              y2={y(tick)}
              strokeWidth={1}
              style={{ stroke: "var(--border)" }}
            />
            <text
              x={PLOT_LEFT - 8}
              y={y(tick) + 4}
              textAnchor="end"
              fontSize={11}
              className="tabular-nums"
              style={{ fill: "var(--text-muted)" }}
            >
              {formatCompactNumber(tick)}
            </text>
          </g>
        ))}
        {data.map((datum, index) => {
          const bx = x(index)
          const topEdge = y(datum.value)
          const h = plotBottom - topEdge
          const d = barPath(bx, topEdge, barW, h, plotBottom)
          const cx = bx + barW / 2
          const isHighlight = index === highlighted
          const tipW = 120
          const tipH = 46
          const tipLeft = Math.min(Math.max(cx - tipW / 2, PLOT_LEFT), plotRight - tipW)
          const tipTop = topEdge - tipH - 10 >= PLOT_TOP - 20 ? topEdge - tipH - 10 : topEdge + 12
          return (
            <g key={datum.label}>
              {d === "" ? null : (
                <path
                  d={d}
                  data-highlight={isHighlight ? "true" : undefined}
                  className={
                    isHighlight
                      ? undefined
                      : "[fill:var(--border-strong)] dark:[fill:var(--surface-2)]"
                  }
                  style={isHighlight ? { fill: "var(--brand)" } : undefined}
                />
              )}
              {isHighlight && d !== "" ? (
                <text
                  x={cx}
                  y={topEdge - 8}
                  textAnchor="middle"
                  fontSize={12}
                  fontWeight={600}
                  className="tabular-nums"
                  style={{ fill: "var(--text-primary)" }}
                >
                  {format(datum.value)}
                </text>
              ) : null}
              <text
                x={cx}
                y={plotBottom + 16}
                textAnchor="middle"
                fontSize={11}
                style={{ fill: "var(--text-muted)" }}
              >
                {datum.label}
              </text>
              <g className="group">
                <rect
                  x={bx - BAR_GAP / 2}
                  y={PLOT_TOP}
                  width={barW + BAR_GAP}
                  height={plotHeight}
                  fill="transparent"
                >
                  <title>{`${datum.label}: ${format(datum.value)}`}</title>
                </rect>
                <g className="opacity-0 group-hover:opacity-100">
                  <rect
                    x={tipLeft}
                    y={tipTop}
                    width={tipW}
                    height={tipH}
                    rx={8}
                    style={{ fill: "var(--surface-1)", stroke: "var(--border)" }}
                  />
                  <text
                    x={tipLeft + 12}
                    y={tipTop + 18}
                    fontSize={11}
                    style={{ fill: "var(--text-muted)" }}
                  >
                    {datum.label}
                  </text>
                  <text
                    x={tipLeft + 12}
                    y={tipTop + 36}
                    fontSize={12}
                    fontWeight={600}
                    className="tabular-nums"
                    style={{ fill: "var(--text-primary)" }}
                  >
                    {format(datum.value)}
                  </text>
                </g>
              </g>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
