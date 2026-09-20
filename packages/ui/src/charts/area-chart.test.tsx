import { describe, expect, test } from "bun:test"
import {
  abbreviateNumber,
  AreaChart,
  buildFillPath,
  buildLinePath,
  niceCeiling,
  resolveHoverDatum,
  type AreaChartDatum,
} from "./area-chart"
import {
  CHART_SERIES_DARK,
  CHART_SERIES_LIGHT,
  CHART_SERIES_SLOT_COUNT,
  chartSeriesColor,
  chartTokensCss,
} from "./chart-tokens"
import { expand, findAll, html } from "../test-helpers"

const DATA: AreaChartDatum[] = [
  { label: "Jan 1", value: 4000, compare: 3200 },
  { label: "Jan 8", value: 7000, compare: 5100 },
  { label: "Jan 15", value: 5200, compare: 6100 },
]

describe("ui/chart-tokens", () => {
  test("fixed slot order matches spec §1 in both modes", () => {
    expect(CHART_SERIES_SLOT_COUNT).toBe(5)
    expect([...CHART_SERIES_LIGHT]).toEqual([
      "#2563eb",
      "#f97316",
      "#14b8a6",
      "#7c3aed",
      "#e11d48",
    ])
    expect([...CHART_SERIES_DARK]).toEqual(["#3b82f6", "#d1720f", "#0d9488", "#8b5cf6", "#f43f5e"])
    expect(chartSeriesColor(0, "light")).toBe("#2563eb")
    expect(chartSeriesColor(0, "dark")).toBe("#3b82f6")
  })

  test("out-of-range slot throws instead of generating a hue", () => {
    expect(() => chartSeriesColor(5, "light")).toThrow(RangeError)
    expect(() => chartSeriesColor(-1, "dark")).toThrow(RangeError)
  })

  test("css carries both columns for dark-mode selection", () => {
    for (const color of [...CHART_SERIES_LIGHT, ...CHART_SERIES_DARK]) {
      expect(chartTokensCss).toContain(color)
    }
    expect(chartTokensCss).toContain(".dark")
  })
})

describe("ui/area-chart helpers", () => {
  test("abbreviateNumber shortens thousands for ticks", () => {
    expect(abbreviateNumber(5000)).toBe("5K")
    expect(abbreviateNumber(10000)).toBe("10K")
    expect(abbreviateNumber(900)).toBe("900")
  })

  test("niceCeiling lands on round tick maxima", () => {
    expect(niceCeiling(9300)).toBe(10000)
    expect(niceCeiling(0)).toBe(1)
  })

  test("line path threads every point, fill closes to the baseline", () => {
    const line = buildLinePath([
      { x: 0, y: 10 },
      { x: 5, y: 20 },
      { x: 10, y: 15 },
    ])
    expect(line.startsWith("M")).toBe(true)
    expect(line.split("L").length - 1).toBe(2)
    expect(buildFillPath([], 30)).toBe("")
    const fill = buildFillPath(
      [
        { x: 0, y: 10 },
        { x: 10, y: 15 },
      ],
      30,
    )
    expect(fill.endsWith("Z")).toBe(true)
    expect(fill).toContain("10,30")
  })

  test("hover lookup resolves the datum under the cursor", () => {
    expect(resolveHoverDatum(DATA, 1)).toEqual(DATA[1])
    expect(resolveHoverDatum(DATA, 9)).toBe(undefined)
  })
})

describe("ui/AreaChart", () => {
  test("legend names both series and direct-labels the current end", () => {
    const output = html(<AreaChart data={DATA} series="Profit" compareSeries="Last period" />)
    expect(output).toContain("Profit")
    expect(output).toContain("Last period")
    expect(output).toContain('data-slot="area-chart-legend"')
    const nodes = expand(<AreaChart data={DATA} series="Profit" compareSeries="Last period" />)
    const legends = findAll(nodes, (node) => node.props["data-slot"] === "area-chart-legend")
    expect(legends.length).toBe(1)
  })

  test("gridlines are horizontal 1px --border only, axis text is muted 11px", () => {
    const nodes = expand(<AreaChart data={DATA} series="Profit" compareSeries="Last period" />)
    const lines = findAll(nodes, (node) => node.type === "line")
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      const style = line.props["style"] as { stroke?: string } | undefined
      if (style?.stroke === "var(--border)") {
        expect(line.props["y1"]).toBe(line.props["y2"])
      }
    }
    const gridlines = lines.filter(
      (line) => (line.props["style"] as { stroke?: string } | undefined)?.stroke === "var(--border)",
    )
    expect(gridlines.length).toBeGreaterThanOrEqual(3)
    const verticalGrid = lines.filter(
      (line) =>
        (line.props["style"] as { stroke?: string } | undefined)?.stroke === "var(--border)" &&
        line.props["x1"] === line.props["x2"],
    )
    expect(verticalGrid).toEqual([])
    const texts = findAll(nodes, (node) => node.type === "text")
    for (const text of texts) {
      expect(text.props["fontSize"]).toBe(11)
    }
  })

  test("hover: full-height hit rect + crosshair + tooltip with both swatched values", () => {
    const nodes = expand(
      <AreaChart data={DATA} series="Profit" compareSeries="Last period" formatValue={(v) => `$${v}`} />,
    )
    const tooltips = findAll(nodes, (node) => node.props["data-slot"] === "area-chart-tooltip")
    expect(tooltips.length).toBe(DATA.length)
    const hits = findAll(
      nodes,
      (node) => node.type === "rect" && node.props["fill"] === "transparent",
    )
    expect(hits.length).toBe(DATA.length)
    for (const hit of hits) {
      expect(Number(hit.props["height"])).toBeGreaterThan(150)
    }
    const output = html(
      <AreaChart data={DATA} series="Profit" compareSeries="Last period" formatValue={(v) => `$${v}`} />,
    )
    expect(output).toContain("$7000")
    expect(output).toContain("$5100")
    expect(output).toContain("var(--chart-1)")
    expect(output).toContain("Jan 8")
  })

  test("empty data renders an empty state and merges className", () => {
    const output = html(<AreaChart data={[]} series="Profit" className="mt-4" />)
    expect(output).toContain("No data available")
    expect(output).toContain("mt-4")
  })

  test("svg scales into the parent width via viewBox", () => {
    const nodes = expand(<AreaChart data={DATA} series="Profit" />)
    const svgs = findAll(nodes, (node) => node.type === "svg")
    expect(svgs.length).toBe(1)
    expect(String(svgs[0]?.props["viewBox"] ?? "")).toContain("0 0 600")
    expect(String(svgs[0]?.props["className"] ?? "")).toContain("w-full")
  })
})
