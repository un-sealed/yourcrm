import * as React from "react"
import { chartSeriesFill, chartTokensCss } from "./chart-tokens"
import { cn } from "../utils"

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

export const AREA_VIEWBOX_WIDTH = 720
export const AREA_VIEWBOX_HEIGHT = 280
const PLOT_LEFT = 40
const PLOT_RIGHT_GUTTER = 56
const PLOT_TOP = 12
const PLOT_BOTTOM_GUTTER = 24
const TOOLTIP_WIDTH = 176

const plotWidth = AREA_VIEWBOX_WIDTH - PLOT_LEFT - PLOT_RIGHT_GUTTER
const plotHeight = AREA_VIEWBOX_HEIGHT - PLOT_TOP - PLOT_BOTTOM_GUTTER
const plotBottom = PLOT_TOP + plotHeight
const plotRight = PLOT_LEFT + plotWidth

/** 5K, 10K, 1.2M … — axis ticks only; tooltips use `formatValue`. */
export function formatCompactNumber(value: number): string {
  const abs = Math.abs(value)
  const sign = value < 0 ? "-" : ""
  const trim = (scaled: number): string => {
    const rounded = Math.round(scaled * 10) / 10
    return `${sign}${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)}`
  }
  if (abs >= 1_000_000) {
    return `${trim(value / 1_000_000)}M`
  }
  if (abs >= 1_000) {
    return `${trim(value / 1_000)}K`
  }
  return String(value)
}

/** Four y ticks (0 + 3 steps) with a 1/2/2.5/5 step; falls back to [0] for empty ranges. */
export function areaYticks(maxValue: number): number[] {
  if (!Number.isFinite(maxValue) || maxValue <= 0) {
    return [0]
  }
  const target = maxValue / 3
  const magnitude = 10 ** Math.floor(Math.log10(target))
  const step = [1, 2, 2.5, 5, 10].find((mult) => mult * magnitude * 3 >= maxValue) ?? 10
  const size = step * magnitude
  return [0, size, size * 2, size * 3]
}

export interface AreaPlotPoint {
  x: number
  y: number
}

/** `M…L…` line path through points (2-decimal coords); a lone point is a bare `M`. */
export function buildLinePath(points: AreaPlotPoint[]): string {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join("")
}

/** Line path closed down to the baseline for the gradient fill. */
export function buildAreaFillPath(points: AreaPlotPoint[], baselineY: number): string {
  if (points.length === 0) {
    return ""
  }
  const first = points[0] as AreaPlotPoint
  const last = points[points.length - 1] as AreaPlotPoint
  return `${buildLinePath(points)}L${last.x.toFixed(2)},${baselineY.toFixed(2)}L${first.x.toFixed(2)},${baselineY.toFixed(2)}Z`
}

/** Datum shown on hover; `null` out of range (hit targets never exceed the data). */
export function getAreaHoverDatum(data: AreaChartDatum[], index: number): AreaChartDatum | null {
  if (!Number.isInteger(index) || index < 0 || index >= data.length) {
    return null
  }
  return data[index] as AreaChartDatum
}

let areaGradientCounter = 0

/** Unique gradient id per chart instance (duplicate ids would alias the fill). */
export function nextAreaGradientId(): string {
  areaGradientCounter += 1
  return `yourcrm-area-fill-${areaGradientCounter}`
}

function defaultFormatValue(value: number): string {
  return value.toLocaleString("en-US")
}

/**
 * Two-series area chart (spec §3 AreaChart). Current series: 2px series-1
 * line with an 18%→0% gradient fill; comparison: 1.5px dashed `--text-muted`
 * with no fill. Horizontal 1px `--border` gridlines only, 11px muted axis
 * text, legend + direct end-label, per-point hover (full-plot-height hit
 * target, crosshair, tooltip card with a swatch per value).
 */
export function AreaChart({ data, series, compareSeries, formatValue, className }: AreaChartProps) {
  const format = formatValue ?? defaultFormatValue
  if (data.length === 0) {
    return (
      <div
        data-slot="area-chart"
        className={cn("flex h-40 items-center justify-center text-sm", className)}
        style={{ color: "var(--text-muted)" }}
      >
        No data available
      </div>
    )
  }

  const gradientId = nextAreaGradientId()
  const maxValue = Math.max(
    0,
    ...data.map((datum) => datum.value),
    ...data.map((datum) => datum.compare ?? 0),
  )
  const ticks = areaYticks(maxValue)
  const top = ticks[ticks.length - 1] as number
  const span = top === 0 ? 1 : top

  const x = (index: number): number =>
    data.length === 1
      ? PLOT_LEFT + plotWidth / 2
      : PLOT_LEFT + (index * plotWidth) / (data.length - 1)
  const y = (value: number): number => PLOT_TOP + plotHeight * (1 - Math.max(0, value) / span)

  const line: AreaPlotPoint[] = data.map((datum, index) => ({ x: x(index), y: y(datum.value) }))
  const compareLine: AreaPlotPoint[] = data
    .map((datum, index) => ({ datum, index }))
    .filter((entry) => entry.datum.compare !== undefined)
    .map((entry) => ({ x: x(entry.index), y: y(entry.datum.compare as number) }))

  const last = data[data.length - 1] as AreaChartDatum
  const lastPoint = line[line.length - 1] as AreaPlotPoint
  const labelEvery = Math.max(1, Math.ceil(data.length / 7))

  const hitLeft = (index: number): number => {
    if (data.length === 1) {
      return PLOT_LEFT
    }
    if (index === 0) {
      return PLOT_LEFT
    }
    return (x(index - 1) + x(index)) / 2
  }
  const hitRight = (index: number): number => {
    if (data.length === 1) {
      return plotRight
    }
    if (index === data.length - 1) {
      return plotRight
    }
    return (x(index) + x(index + 1)) / 2
  }

  const tooltipHeight = (datum: AreaChartDatum): number => (datum.compare === undefined ? 48 : 66)
  const tooltipLeft = (index: number): number =>
    Math.min(Math.max(x(index) + 12, PLOT_LEFT), plotRight - TOOLTIP_WIDTH)
  const tooltipTop = (index: number, datum: AreaChartDatum): number => {
    const below = y(datum.value) + 16
    const above = y(datum.value) - tooltipHeight(datum) - 10
    return above >= PLOT_TOP - 8 ? above : below
  }

  return (
    <div data-slot="area-chart" className={cn("w-full", className)}>
      <style>{chartTokensCss()}</style>
      {compareSeries === undefined ? null : (
        <div data-slot="legend" className="flex items-center justify-end gap-4 pb-2 text-xs">
          <span
            className="inline-flex items-center gap-1.5"
            style={{ color: "var(--text-secondary)" }}
          >
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: chartSeriesFill(0) }}
            />
            {series}
          </span>
          <span
            className="inline-flex items-center gap-1.5"
            style={{ color: "var(--text-secondary)" }}
          >
            <svg width="20" height="6" aria-hidden="true">
              <line
                x1="0"
                y1="3"
                x2="20"
                y2="3"
                strokeWidth="1.5"
                strokeDasharray="4 3"
                style={{ stroke: "var(--text-muted)" }}
              />
            </svg>
            {compareSeries}
          </span>
        </div>
      )}
      <svg
        viewBox={`0 0 ${AREA_VIEWBOX_WIDTH} ${AREA_VIEWBOX_HEIGHT}`}
        role="img"
        aria-label={`${series} area chart`}
        className="h-auto w-full"
      >
        <title>{series}</title>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: chartSeriesFill(0) }} stopOpacity={0.18} />
            <stop offset="100%" style={{ stopColor: chartSeriesFill(0) }} stopOpacity={0} />
          </linearGradient>
        </defs>
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
        {data.map((datum, index) =>
          index % labelEvery === 0 || index === data.length - 1 ? (
            <text
              key={datum.label}
              x={x(index)}
              y={plotBottom + 16}
              textAnchor="middle"
              fontSize={11}
              style={{ fill: "var(--text-muted)" }}
            >
              {datum.label}
            </text>
          ) : null,
        )}
        {compareLine.length > 1 ? (
          <path
            d={buildLinePath(compareLine)}
            fill="none"
            strokeWidth={1.5}
            strokeDasharray="5 4"
            style={{ stroke: "var(--text-muted)" }}
          />
        ) : null}
        {line.length > 1 ? (
          <path d={buildAreaFillPath(line, plotBottom)} fill={`url(#${gradientId})`} />
        ) : null}
        {line.length > 1 ? (
          <path
            d={buildLinePath(line)}
            fill="none"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            style={{ stroke: chartSeriesFill(0) }}
          />
        ) : (
          <circle cx={lastPoint.x} cy={lastPoint.y} r={3.5} style={{ fill: chartSeriesFill(0) }} />
        )}
        <text
          x={Math.min(lastPoint.x + 8, plotRight - 8)}
          y={lastPoint.y + 4}
          fontSize={12}
          fontWeight={600}
          className="tabular-nums"
          style={{ fill: "var(--text-primary)" }}
        >
          {format(last.value)}
        </text>
        {data.map((datum, index) => {
          const height = tooltipHeight(datum)
          const left = tooltipLeft(index)
          const topEdge = tooltipTop(index, datum)
          return (
            <g key={datum.label} className="group">
              <line
                x1={x(index)}
                x2={x(index)}
                y1={PLOT_TOP}
                y2={plotBottom}
                strokeWidth={1}
                className="opacity-0 group-hover:opacity-100"
                style={{ stroke: "var(--border-strong)" }}
              />
              <rect
                x={hitLeft(index)}
                y={PLOT_TOP}
                width={Math.max(1, hitRight(index) - hitLeft(index))}
                height={plotHeight}
                fill="transparent"
              >
                <title>{`${datum.label}: ${format(datum.value)}`}</title>
              </rect>
              <g className="opacity-0 group-hover:opacity-100">
                <rect
                  x={left}
                  y={topEdge}
                  width={TOOLTIP_WIDTH}
                  height={height}
                  rx={8}
                  style={{ fill: "var(--surface-1)", stroke: "var(--border)" }}
                />
                <text
                  x={left + 12}
                  y={topEdge + 18}
                  fontSize={11}
                  style={{ fill: "var(--text-muted)" }}
                >
                  {datum.label}
                </text>
                <rect
                  x={left + 12}
                  y={topEdge + 26}
                  width={8}
                  height={8}
                  rx={2}
                  style={{ fill: chartSeriesFill(0) }}
                />
                <text
                  x={left + 26}
                  y={topEdge + 34}
                  fontSize={12}
                  className="tabular-nums"
                  style={{ fill: "var(--text-primary)" }}
                >
                  {`${series} ${format(datum.value)}`}
                </text>
                {datum.compare === undefined || compareSeries === undefined ? null : (
                  <g>
                    <line
                      x1={left + 12}
                      x2={left + 20}
                      y1={topEdge + 48}
                      y2={topEdge + 48}
                      strokeWidth={1.5}
                      strokeDasharray="3 2"
                      style={{ stroke: "var(--text-muted)" }}
                    />
                    <text
                      x={left + 26}
                      y={topEdge + 52}
                      fontSize={12}
                      className="tabular-nums"
                      style={{ fill: "var(--text-primary)" }}
                    >
                      {`${compareSeries} ${format(datum.compare)}`}
                    </text>
                  </g>
                )}
              </g>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
