import { describe, expect, test } from "bun:test"
import { StatTile } from "./stat-tile"
import { expand, findAll, html, only, textOf } from "../test-helpers"

describe("ui/StatTile", () => {
  test("renders label, value, caption and icon", () => {
    const node = only(
      expand(
        <StatTile
          label="Total revenue"
          value="$48.2K"
          caption="vs. 14,653 last period"
          icon={<span>icon-glyph</span>}
        />,
      ),
    )
    const text = textOf(node)
    expect(text).toContain("Total revenue")
    expect(text).toContain("$48.2K")
    expect(text).toContain("vs. 14,653 last period")
    expect(text).toContain("icon-glyph")
  })

  test("up delta pairs ▲ with good tones, down pairs ▼ with bad tones", () => {
    const up = html(<StatTile label="L" value="1" delta={{ value: "+12%", direction: "up" }} />)
    expect(up).toContain("▲")
    expect(up).toContain("+12%")
    expect(up).toContain("var(--good)")
    expect(up).toContain("var(--good-soft)")

    const down = html(<StatTile label="L" value="1" delta={{ value: "-4%", direction: "down" }} />)
    expect(down).toContain("▼")
    expect(down).toContain("-4%")
    expect(down).toContain("var(--bad)")
    expect(down).toContain("var(--bad-soft)")
  })

  test("value is tabular-nums and the delta carries its direction", () => {
    const nodes = expand(<StatTile label="L" value="42" delta={{ value: "+1", direction: "up" }} />)
    const values = findAll(nodes, (node) => textOf(node) === "42")
    expect(values.length).toBeGreaterThan(0)
    expect(String(values[0]?.props["className"] ?? "")).toContain("tabular-nums")
    const deltas = findAll(nodes, (node) => node.props["data-slot"] === "stat-tile-delta")
    expect(deltas.length).toBe(1)
    expect(deltas[0]?.props["data-direction"]).toBe("up")
  })

  test("bare tile ships no hover layer and merges className", () => {
    const output = html(<StatTile label="L" value="1" className="ml-2" />)
    expect(output).toContain("ml-2")
    expect(output).not.toContain("group-hover")
    const nodes = expand(<StatTile label="L" value="1" />)
    const tooltips = findAll(nodes, (node) =>
      String(node.props["data-slot"] ?? "").includes("tooltip"),
    )
    expect(tooltips).toEqual([])
  })
})
