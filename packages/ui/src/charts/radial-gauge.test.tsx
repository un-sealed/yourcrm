import { describe, expect, test } from "bun:test"
import { buildGaugeTicks, filledTickCount, RadialGauge } from "./radial-gauge"
import { expand, findAll, html, textOf } from "../test-helpers"

describe("ui/radial-gauge helpers", () => {
  test("filled ticks track value/max proportionally", () => {
    expect(filledTickCount(75, 100)).toBe(45)
    expect(filledTickCount(0, 100)).toBe(0)
    expect(filledTickCount(100, 100)).toBe(60)
  })

  test("clamps over/underflow and rejects bad input", () => {
    expect(filledTickCount(150, 100)).toBe(60)
    expect(filledTickCount(-5, 100)).toBe(0)
    expect(filledTickCount(50, 0)).toBe(0)
    expect(filledTickCount(Number.NaN, 100)).toBe(0)
  })

  test("ticks lie on a 270° arc with a bottom gap", () => {
    const ticks = buildGaugeTicks(50, 100)
    expect(ticks.length).toBe(60)
    expect(ticks.filter((tick) => tick.filled).length).toBe(30)
    for (const tick of ticks) {
      expect(tick.y1).toBeLessThan(172)
      expect(tick.y2).toBeLessThan(172)
      expect(Math.hypot(tick.x1 - tick.x2, tick.y1 - tick.y2)).toBeGreaterThan(9)
    }
    const first = ticks[0]
    expect(first).toBeDefined()
    if (first !== undefined) {
      const angle = Math.atan2(first.y1 - 100, first.x1 - 100)
      expect(angle).toBeGreaterThan(0)
    }
  })
})

describe("ui/RadialGauge", () => {
  test("renders ~60 ticks, filled good and remainder border", () => {
    const nodes = expand(<RadialGauge value={75} max={100} />)
    const ticks = findAll(nodes, (node) => node.props["data-slot"] === "radial-gauge-tick")
    expect(ticks.length).toBe(60)
    const filled = ticks.filter((tick) => tick.props["data-filled"] === true)
    expect(filled.length).toBe(45)
    const output = html(<RadialGauge value={75} max={100} />)
    expect(output).toContain("var(--good)")
    expect(output).toContain("var(--border)")
  })

  test("centre value is tabular with label and caption", () => {
    const nodes = expand(
      <RadialGauge value={68} label="Repeat Customer Rate" caption="of customers return" />,
    )
    const values = findAll(nodes, (node) => node.props["data-slot"] === "radial-gauge-value")
    expect(values.length).toBe(1)
    const valueNode = values[0]
    expect(valueNode).toBeDefined()
    if (valueNode !== undefined) {
      expect(textOf(valueNode)).toContain("68")
      expect(String(valueNode.props["className"] ?? "")).toContain("tabular-nums")
    }
    const output = html(
      <RadialGauge value={68} label="Repeat Customer Rate" caption="of customers return" />,
    )
    expect(output).toContain("Repeat Customer Rate")
    expect(output).toContain("of customers return")
  })

  test("single value ⇒ no legend, no hover layer, viewBox scaling", () => {
    const output = html(<RadialGauge value={10} className="mx-auto" />)
    expect(output).not.toContain("legend")
    expect(output).not.toContain("group-hover")
    expect(output).toContain("mx-auto")
    const nodes = expand(<RadialGauge value={10} />)
    const svgs = findAll(nodes, (node) => node.type === "svg")
    expect(svgs.length).toBe(1)
    expect(String(svgs[0]?.props["viewBox"] ?? "")).toBe("0 0 200 150")
    expect(String(svgs[0]?.props["className"] ?? "")).toContain("w-full")
  })
})
