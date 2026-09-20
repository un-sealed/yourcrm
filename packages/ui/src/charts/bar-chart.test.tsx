import { describe, expect, test } from "bun:test"
import {
  BarChart,
  barPath,
  defaultHighlightIndex,
  getBarHoverDatum,
  resolveHighlightIndex,
} from "./bar-chart"
import { expand, findAll, html, only, textOf } from "../test-helpers"

const DATA = [
  { label: "Mon", value: 12 },
  { label: "Tue", value: 30 },
  { label: "Wed", value: 18 },
  { label: "Thu", value: 7 },
]

describe("ui/bar helpers", () => {
  test("defaultHighlightIndex picks the first maximum", () => {
    expect(defaultHighlightIndex(DATA)).toBe(1)
    expect(defaultHighlightIndex([])).toBe(-1)
  })

  test("resolveHighlightIndex keeps an explicit in-range index, else the default", () => {
    expect(resolveHighlightIndex(DATA, 3)).toBe(3)
    expect(resolveHighlightIndex(DATA, 99)).toBe(1)
    expect(resolveHighlightIndex(DATA, -1)).toBe(1)
    expect(resolveHighlightIndex(DATA)).toBe(1)
  })

  test("barPath rounds the top, anchors to the baseline, skips empty bars", () => {
    const d = barPath(10, 50, 20, 100, 150)
    expect(d.startsWith("M10.00,150.00")).toBe(true)
    expect(d.endsWith("Z")).toBe(true)
    expect(d).toContain("Q")
    expect(barPath(10, 150, 20, 0, 150)).toBe("")
    expect(barPath(10, 150, 0, 10, 150)).toBe("")
  })

  test("barPath emits coordinates an SVG parser reads back inside the bar", () => {
    // Regression: the curve commands once ran their control point straight
    // into their endpoint ("Q10.00,50.0014.00,50.00"), which a path parser
    // reads as the single number 50.0014 followed by .00 — every bar drew as
    // a diagonal wedge. Asserting the string "contains Q" did not catch it,
    // so parse the numbers back out and bound them to the bar's own box.
    const x = 10
    const yTop = 50
    const w = 20
    const yb = 150
    const d = barPath(x, yTop, w, 100, yb)

    const numbers = d.match(/-?\d+(?:\.\d+)?/g) ?? []
    expect(numbers.length).toBe(16) // 8 coordinate pairs: 2 corners + 2 curves
    for (let i = 0; i < numbers.length; i += 2) {
      const px = Number(numbers[i])
      const py = Number(numbers[i + 1])
      expect(px).toBeGreaterThanOrEqual(x)
      expect(px).toBeLessThanOrEqual(x + w)
      expect(py).toBeGreaterThanOrEqual(yTop)
      expect(py).toBeLessThanOrEqual(yb)
    }
  })

  test("getBarHoverDatum resolves the hovered bar and rejects the rest", () => {
    expect(getBarHoverDatum(DATA, 0)).toEqual(DATA[0] ?? null)
    expect(getBarHoverDatum(DATA, DATA.length)).toBe(null)
    expect(getBarHoverDatum(DATA, -1)).toBe(null)
  })
})

describe("ui/BarChart", () => {
  test("renders one bar per datum with day labels", () => {
    const node = only(expand(<BarChart data={DATA} />))
    const text = textOf(node)
    for (const day of ["Mon", "Tue", "Wed", "Thu"]) {
      expect(text).toContain(day)
    }
  })

  test("highlight wears --brand, the rest are de-emphasised (no legend, no palette slot)", () => {
    const nodes = expand(<BarChart data={DATA} />)
    expect(findAll(nodes, (entry) => entry.props["data-slot"] === "legend")).toHaveLength(0)
    const highlighted = findAll(nodes, (entry) => entry.props["data-highlight"] === "true")
    expect(highlighted).toHaveLength(1)
    const markup = html(<BarChart data={DATA} />)
    expect(markup).toContain("var(--brand)")
    // De-emphasised bars wear --mark-muted, which carries its own per-mode
    // value. They previously borrowed --surface-2 in dark, which put a
    // #1a1d22 bar on a #14161a card and made them invisible.
    expect(markup).toContain("var(--mark-muted)")
    const bars = findAll(nodes, (entry) => entry.type === "path")
    expect(bars.length).toBeGreaterThan(0)
    for (const bar of bars) {
      const paint = `${String(bar.props["className"] ?? "")}${JSON.stringify(bar.props["style"] ?? {})}`
      expect(paint).not.toContain("--chart-")
    }
  })

  test("explicit highlightIndex wins over the max-value default", () => {
    const nodes = expand(<BarChart data={DATA} highlightIndex={3} />)
    const highlighted = findAll(nodes, (entry) => entry.props["data-highlight"] === "true")
    expect(highlighted).toHaveLength(1)
    expect(textOf(only(nodes))).toContain("7")
  })

  test("value label sits above the highlighted bar only", () => {
    const text = textOf(only(expand(<BarChart data={DATA} />)))
    expect(text).toContain("30")
  })

  test("every bar ships a per-mark hover tooltip", () => {
    const nodes = expand(<BarChart data={DATA} />)
    const hits = findAll(
      nodes,
      (entry) => entry.type === "rect" && entry.props["fill"] === "transparent",
    )
    expect(hits).toHaveLength(DATA.length)
    const tooltips = findAll(
      nodes,
      (entry) => entry.type === "rect" && entry.props["width"] === 120,
    )
    expect(tooltips).toHaveLength(DATA.length)
    expect(textOf(only(nodes))).toContain("Tue")
  })

  test("empty data renders an empty state, never an empty svg", () => {
    const node = only(expand(<BarChart data={[]} />))
    expect(textOf(node)).toContain("No data available")
    expect(findAll([node], (entry) => entry.type === "svg")).toHaveLength(0)
  })

  test("scales to the parent width via viewBox, merges className", () => {
    // NB: the static serializer drops `viewBox`, so assert it on the tree.
    const svg = findAll(
      expand(<BarChart data={DATA} />),
      (entry) => entry.type === "svg" && entry.props["role"] === "img",
    )
    expect(svg).toHaveLength(1)
    expect(svg[0]?.props["viewBox"]).toBe("0 0 720 280")
    const markup = html(<BarChart data={DATA} className="ml-2" />)
    expect(markup).toContain("ml-2")
    expect(markup).not.toContain("ResponsiveContainer")
  })
})
