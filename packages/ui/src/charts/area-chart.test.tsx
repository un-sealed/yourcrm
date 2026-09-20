import { describe, expect, test } from "bun:test"
import {
  AreaChart,
  areaYticks,
  buildAreaFillPath,
  buildLinePath,
  formatCompactNumber,
  getAreaHoverDatum,
  nextAreaGradientId,
  type AreaChartDatum,
} from "./area-chart"
import { expand, findAll, html, only, textOf } from "../test-helpers"

const DATA: AreaChartDatum[] = [
  { label: "Jan", value: 4200, compare: 3800 },
  { label: "Feb", value: 6800, compare: 5100 },
  { label: "Mar", value: 5900, compare: 6200 },
  { label: "Apr", value: 9100, compare: 7400 },
]

describe("ui/area helpers", () => {
  test("formatCompactNumber abbreviates axis ticks", () => {
    expect(formatCompactNumber(0)).toBe("0")
    expect(formatCompactNumber(500)).toBe("500")
    expect(formatCompactNumber(5000)).toBe("5K")
    expect(formatCompactNumber(14653)).toBe("14.7K")
    expect(formatCompactNumber(2_400_000)).toBe("2.4M")
  })

  test("areaYticks returns four 1/2/2.5/5 steps covering the max", () => {
    expect(areaYticks(10_000)).toEqual([0, 5000, 10_000, 15_000])
    expect(areaYticks(0)).toEqual([0])
    expect(areaYticks(-4)).toEqual([0])
  })

  test("line and fill paths share the stroke and close to the baseline", () => {
    const line = buildLinePath([
      { x: 0, y: 10 },
      { x: 5, y: 20 },
    ])
    expect(line).toBe("M0.00,10.00L5.00,20.00")
    expect(buildAreaFillPath([], 30)).toBe("")
    expect(buildAreaFillPath([{ x: 0, y: 10 }], 30)).toContain("Z")
  })

  test("getAreaHoverDatum resolves the hovered point and rejects the rest", () => {
    expect(getAreaHoverDatum(DATA, 1)).toEqual(DATA[1] ?? null)
    expect(getAreaHoverDatum(DATA, -1)).toBe(null)
    expect(getAreaHoverDatum(DATA, DATA.length)).toBe(null)
  })

  test("gradient ids are unique per instance", () => {
    expect(nextAreaGradientId()).not.toBe(nextAreaGradientId())
  })
})

describe("ui/AreaChart", () => {
  test("renders axes, legend and a direct end-label on the current series", () => {
    const node = only(expand(<AreaChart data={DATA} series="Profit" compareSeries="Last period" />))
    expect(node.type).toBe("div")
    const text = textOf(node)
    for (const label of ["Jan", "Feb", "Mar", "Apr"]) {
      expect(text).toContain(label)
    }
    expect(text).toContain("Profit")
    expect(text).toContain("Last period")
    expect(text).toContain("9,100")
    const legends = findAll([node], (entry) => entry.props["data-slot"] === "legend")
    expect(legends).toHaveLength(1)
  })

  test("current series is 2px series-1, comparison is dashed muted with no fill", () => {
    const markup = html(<AreaChart data={DATA} series="Profit" compareSeries="Last period" />)
    expect(markup).toContain("var(--chart-1)")
    const nodes = expand(<AreaChart data={DATA} series="Profit" compareSeries="Last period" />)
    const dashed = findAll(
      nodes,
      (entry) =>
        entry.type === "path" &&
        (entry.props["strokeDasharray"] ?? entry.props["stroke-dasharray"]) !== undefined,
    )
    expect(dashed.length).toBeGreaterThan(0)
    for (const path of dashed) {
      expect(path.props["fill"]).toBe("none")
    }
    const svg = findAll(nodes, (entry) => entry.type === "svg" && entry.props["role"] === "img")
    expect(svg).toHaveLength(1)
    expect(svg[0]?.props["viewBox"]).toBe("0 0 720 280")
  })

  test("hover ships a full-plot-height hit target, crosshair and tooltip per point", () => {
    const nodes = expand(<AreaChart data={DATA} series="Profit" compareSeries="Last period" />)
    const hits = findAll(
      nodes,
      (entry) => entry.type === "rect" && entry.props["fill"] === "transparent",
    )
    expect(hits).toHaveLength(DATA.length)
    for (const hit of hits) {
      expect(hit.props["height"]).toBeGreaterThan(200)
    }
    const tooltips = findAll(
      nodes,
      (entry) => entry.type === "rect" && entry.props["width"] === 176,
    )
    expect(tooltips).toHaveLength(DATA.length)
    const text = textOf(only(nodes))
    expect(text).toContain("Last period 7,400")
    const hoverables = findAll(
      nodes,
      (entry) =>
        typeof entry.props["className"] === "string" &&
        (entry.props["className"] as string).includes("group-hover:opacity-100"),
    )
    expect(hoverables.length).toBeGreaterThanOrEqual(DATA.length * 2)
  })

  test("single series renders without a legend", () => {
    const nodes = expand(<AreaChart data={DATA} series="Profit" />)
    expect(findAll(nodes, (entry) => entry.props["data-slot"] === "legend")).toHaveLength(0)
  })

  test("empty data renders an empty state, never an empty svg", () => {
    const node = only(expand(<AreaChart data={[]} series="Profit" />))
    expect(textOf(node)).toContain("No data available")
    expect(findAll([node], (entry) => entry.type === "svg")).toHaveLength(0)
  })

  test("scales to the parent width via viewBox, no fixed pixel widths", () => {
    // NB: the static serializer drops `viewBox`, so assert it on the tree.
    const svg = findAll(
      expand(<AreaChart data={DATA} series="Profit" />),
      (entry) => entry.type === "svg" && entry.props["role"] === "img",
    )
    expect(svg).toHaveLength(1)
    expect(svg[0]?.props["viewBox"]).toBe("0 0 720 280")
    expect(String(svg[0]?.props["className"] ?? "")).toContain("w-full")
    const markup = html(<AreaChart data={DATA} series="Profit" className="ml-2" />)
    expect(markup).toContain("ml-2")
    expect(markup).not.toContain("ResponsiveContainer")
  })
})
