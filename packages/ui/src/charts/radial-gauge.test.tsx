import { describe, expect, test } from "bun:test"
import { GAUGE_TICK_COUNT, RadialGauge, filledTickCount, polar } from "./radial-gauge"
import { expand, findAll, html, only, textOf } from "../test-helpers"

describe("ui/gauge helpers", () => {
  test("polar resolves screen-space points", () => {
    const east = polar(100, 88, 80, 0)
    expect(east.x).toBeCloseTo(180)
    expect(east.y).toBeCloseTo(88)
    const north = polar(100, 88, 80, 270)
    expect(north.x).toBeCloseTo(100)
    expect(north.y).toBeCloseTo(8)
  })

  test("filledTickCount proportions and clamps", () => {
    expect(filledTickCount(50, 100, 60)).toBe(30)
    expect(filledTickCount(0, 100, 60)).toBe(0)
    expect(filledTickCount(-5, 100, 60)).toBe(0)
    expect(filledTickCount(150, 100, 60)).toBe(60)
    expect(filledTickCount(100, 100, 60)).toBe(60)
    expect(filledTickCount(10, 0, 60)).toBe(0)
    expect(filledTickCount(10, -4, 60)).toBe(0)
  })
})

describe("ui/RadialGauge", () => {
  test("renders the tick arc with the value and caption centred", () => {
    const node = only(expand(<RadialGauge value={68} label="Repeat rate" caption="of customers" />))
    expect(node.type).toBe("div")
    const ticks = findAll([node], (entry) => entry.type === "line")
    expect(ticks).toHaveLength(GAUGE_TICK_COUNT)
    const text = textOf(node)
    expect(text).toContain("68")
    expect(text).toContain("Repeat rate")
    expect(text).toContain("of customers")
  })

  test("lit ticks wear --good, the rest --border, in order", () => {
    const nodes = expand(<RadialGauge value={50} max={100} />)
    const ticks = findAll(nodes, (entry) => entry.type === "line")
    const lit = ticks.filter(
      (tick) => (tick.props["style"] as { stroke: string }).stroke === "var(--good)",
    )
    expect(lit).toHaveLength(filledTickCount(50, 100, GAUGE_TICK_COUNT))
    const litIndices = ticks
      .map((tick, index) => ({ tick, index }))
      .filter(({ tick }) => (tick.props["style"] as { stroke: string }).stroke === "var(--good)")
      .map(({ index }) => index)
    expect(litIndices).toEqual(Array.from({ length: 30 }, (_, index) => index))
  })

  test("single value ships no legend and no hover layer", () => {
    const markup = html(<RadialGauge value={68} className="ml-2" />)
    expect(markup).toContain("ml-2")
    expect(markup).not.toContain("group-hover")
    const nodes = expand(<RadialGauge value={68} />)
    expect(findAll(nodes, (entry) => entry.props["data-slot"] === "legend")).toHaveLength(0)
    const svg = findAll(nodes, (entry) => entry.type === "svg" && entry.props["role"] === "img")
    expect(svg).toHaveLength(1)
  })

  test("scales to the parent width via viewBox", () => {
    // NB: the static serializer drops `viewBox`, so assert it on the tree.
    const svg = findAll(
      expand(<RadialGauge value={68} />),
      (entry) => entry.type === "svg" && entry.props["role"] === "img",
    )
    expect(svg[0]?.props["viewBox"]).toBe("0 0 200 176")
  })
})
