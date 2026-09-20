import { describe, expect, test } from "bun:test"
import { BarChart, buildBarPath, defaultHighlightIndex, type BarChartDatum } from "./bar-chart"
import { expand, findAll, html, textOf } from "../test-helpers"

const DATA: BarChartDatum[] = [
  { label: "Mon", value: 42 },
  { label: "Tue", value: 88 },
  { label: "Wed", value: 61 },
]

describe("ui/bar-chart helpers", () => {
  test("default highlight is the max (ties keep the first)", () => {
    expect(defaultHighlightIndex(DATA)).toBe(1)
    expect(
      defaultHighlightIndex([
        { label: "A", value: 5 },
        { label: "B", value: 5 },
      ]),
    ).toBe(0)
  })

  test("bar path is top-rounded and anchored to the baseline", () => {
    const path = buildBarPath(0, 10, 20, 50)
    expect(path.endsWith("Z")).toBe(true)
    expect(path).toContain("Q")
    expect(path).toContain("60")
    expect(path).not.toContain("NaN")
  })
})

describe("ui/BarChart", () => {
  test("highlighted bar wears the series slot, the rest are de-emphasized", () => {
    const nodes = expand(<BarChart data={DATA} highlightIndex={1} />)
    const bars = findAll(nodes, (node) => node.props["data-slot"] === "bar-chart-bar")
    expect(bars.length).toBe(DATA.length)
    for (const bar of bars) {
      expect(bar.props["data-highlighted"]).toBe(bar.props["data-index"] === 1)
    }
    const output = html(<BarChart data={DATA} highlightIndex={1} />)
    expect(output).toContain("var(--chart-1)")
    expect(output).toContain("var(--chart-muted-bar)")
  })

  test("single series ⇒ no legend, value label above the highlighted bar only", () => {
    const nodes = expand(
      <BarChart data={DATA} highlightIndex={1} formatValue={(value) => `${value} visits`} />,
    )
    const labels = findAll(
      nodes,
      (node) => node.props["data-slot"] === "bar-chart-highlight-label",
    )
    expect(labels.length).toBe(1)
    const label = labels[0]
    expect(label).toBeDefined()
    if (label !== undefined) {
      expect(textOf(label)).toBe("88 visits")
    }
    const output = html(
      <BarChart data={DATA} highlightIndex={1} formatValue={(value) => `${value} visits`} />,
    )
    expect(output).not.toContain("legend")
    expect(output).toContain("88 visits")
  })

  test("hover: per-bar tooltip naming its own label and value", () => {
    const nodes = expand(<BarChart data={DATA} highlightIndex={0} />)
    const tooltips = findAll(nodes, (node) => node.props["data-slot"] === "bar-chart-tooltip")
    expect(tooltips.length).toBe(DATA.length)
    const output = html(<BarChart data={DATA} highlightIndex={0} />)
    for (const datum of DATA) {
      expect(output).toContain(datum.label)
    }
  })

  test("bars use a 2px gap and horizontal gridlines only", () => {
    const nodes = expand(<BarChart data={DATA} />)
    const lines = findAll(nodes, (node) => node.type === "line")
    const gridlines = lines.filter(
      (line) => (line.props["style"] as { stroke?: string } | undefined)?.stroke === "var(--border)",
    )
    expect(gridlines.length).toBeGreaterThanOrEqual(3)
    for (const line of gridlines) {
      expect(line.props["y1"]).toBe(line.props["y2"])
    }
  })

  test("empty data renders an empty state and svg scales via viewBox", () => {
    const empty = html(<BarChart data={[]} className="mt-4" />)
    expect(empty).toContain("No data available")
    expect(empty).toContain("mt-4")
    const nodes = expand(<BarChart data={DATA} />)
    const svgs = findAll(nodes, (node) => node.type === "svg")
    expect(svgs.length).toBe(1)
    expect(String(svgs[0]?.props["viewBox"] ?? "")).toContain("0 0 600")
    expect(String(svgs[0]?.props["className"] ?? "")).toContain("w-full")
  })
})
