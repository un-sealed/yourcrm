import { seriesMax } from "./grid-math"
import type {
  DashboardWidget,
  MetricWidgetConfig,
  SeriesWidgetConfig,
  TableWidgetConfig,
} from "../types"

/**
 * Widget body renderer. No charting library is installed in this workspace
 * and module agents may not add one (`AGENTS.md`), so bar/line widgets are
 * plain inline SVG driven by `widget.config.series` — a small, accessible,
 * dependency-free chart. `config` is P0 preview data (typed in by hand)
 * until the reports module (owned separately) can execute `reportId` and
 * feed real series into it.
 */

const CHART_WIDTH = 240
const CHART_HEIGHT = 96
const PALETTE = ["#2563eb", "#0ea5e9", "#14b8a6", "#f59e0b", "#ef4444", "#8b5cf6"]

function NoData({ hint }: { hint: string }) {
  return <p className="text-xs text-muted-foreground">{hint}</p>
}

function MetricBody({ config }: { config: MetricWidgetConfig | null }) {
  if (!config || config.value === undefined) {
    return <NoData hint="Set a value in the widget's config to preview a number here." />
  }
  return (
    <p className="text-3xl font-semibold text-foreground">
      {config.value.toLocaleString()}
      {config.unit ? (
        <span className="ml-1 text-base font-normal text-muted-foreground">{config.unit}</span>
      ) : null}
    </p>
  )
}

function TableBody({ config }: { config: TableWidgetConfig | null }) {
  const columns = config?.columns ?? []
  const rows = config?.rows ?? []
  if (columns.length === 0) {
    return <NoData hint="Add columns and rows in the widget's config to preview a table here." />
  }
  return (
    <table className="w-full text-left text-xs">
      <caption className="sr-only">Widget table preview</caption>
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col} scope="col" className="border-b border-border pb-1 pr-2 font-medium">
              {col}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 5).map((row, i) => (
          <tr key={`${i}-${row.join("|")}`}>
            {row.map((cell, j) => (
              <td
                key={`${j}-${cell}`}
                className="border-b border-border/60 py-1 pr-2 text-muted-foreground"
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function BarChart({ config }: { config: SeriesWidgetConfig | null }) {
  const series = config?.series ?? []
  if (series.length === 0) {
    return <NoData hint="Add a series in the widget's config to preview a bar chart here." />
  }
  const max = seriesMax(series)
  const barWidth = CHART_WIDTH / series.length
  return (
    <svg
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      role="img"
      aria-label={`Bar chart: ${series.map((s) => `${s.label} ${s.value}`).join(", ")}`}
      className="h-24 w-full"
    >
      {series.map((s, i) => {
        const barHeight = (s.value / max) * (CHART_HEIGHT - 16)
        return (
          <g key={s.label}>
            <rect
              x={i * barWidth + barWidth * 0.15}
              y={CHART_HEIGHT - barHeight}
              width={barWidth * 0.7}
              height={barHeight}
              fill={PALETTE[i % PALETTE.length]}
            />
            <text
              x={i * barWidth + barWidth / 2}
              y={CHART_HEIGHT - 2}
              textAnchor="middle"
              fontSize="8"
              fill="currentColor"
              className="text-muted-foreground"
            >
              {s.label.slice(0, 6)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function LineChart({ config }: { config: SeriesWidgetConfig | null }) {
  const series = config?.series ?? []
  if (series.length === 0) {
    return <NoData hint="Add a series in the widget's config to preview a line chart here." />
  }
  const max = seriesMax(series)
  const stepX = series.length > 1 ? CHART_WIDTH / (series.length - 1) : 0
  const points = series
    .map((s, i) => {
      const x = series.length > 1 ? i * stepX : CHART_WIDTH / 2
      const y = CHART_HEIGHT - 16 - (s.value / max) * (CHART_HEIGHT - 24)
      return `${x},${y}`
    })
    .join(" ")
  return (
    <svg
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      role="img"
      aria-label={`Line chart: ${series.map((s) => `${s.label} ${s.value}`).join(", ")}`}
      className="h-24 w-full"
    >
      <polyline points={points} fill="none" stroke={PALETTE[0]} strokeWidth={2} />
      {series.map((s, i) => {
        const x = series.length > 1 ? i * stepX : CHART_WIDTH / 2
        const y = CHART_HEIGHT - 16 - (s.value / max) * (CHART_HEIGHT - 24)
        return <circle key={s.label} cx={x} cy={y} r={2.5} fill={PALETTE[0]} />
      })}
    </svg>
  )
}

export function WidgetBody({ widget }: { widget: DashboardWidget }) {
  switch (widget.type) {
    case "metric":
      return <MetricBody config={widget.config as MetricWidgetConfig | null} />
    case "table":
      return <TableBody config={widget.config as TableWidgetConfig | null} />
    case "bar":
      return <BarChart config={widget.config as SeriesWidgetConfig | null} />
    case "line":
      return <LineChart config={widget.config as SeriesWidgetConfig | null} />
    default:
      return <NoData hint="Unknown widget type." />
  }
}
