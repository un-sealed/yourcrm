import { describe, expect, test } from "bun:test"
import { StatTile } from "./stat-tile"
import { expand, findAll, html, only, textOf } from "../test-helpers"

describe("ui/StatTile", () => {
  test("renders label, value and caption", () => {
    const node = only(
      expand(<StatTile label="Total revenue" value="$48,200" caption="vs. 14,653 last period" />),
    )
    expect(node.type).toBe("div")
    expect(textOf(node)).toContain("Total revenue")
    expect(textOf(node)).toContain("$48,200")
    expect(textOf(node)).toContain("vs. 14,653 last period")
  })

  test("value uses tabular-nums and the delta pill carries a direction glyph (never color alone)", () => {
    const up = html(
      <StatTile label="Revenue" value="$1" delta={{ value: "12.4%", direction: "up" }} />,
    )
    expect(up).toContain("tabular-nums")
    expect(up).toContain("▲")
    expect(up).toContain("12.4%")
    const down = html(
      <StatTile label="Churn" value="$1" delta={{ value: "3.1%", direction: "down" }} />,
    )
    expect(down).toContain("▼")
  })

  test("delta pill resolves good/bad tones from direction", () => {
    const nodes = expand(
      <StatTile label="Revenue" value="$1" delta={{ value: "1%", direction: "up" }} />,
    )
    const pills = findAll(nodes, (node) => node.props["data-slot"] === "stat-tile-delta")
    expect(pills).toHaveLength(1)
    const style = pills[0]?.props["style"] as Record<string, string>
    expect(style["color"]).toBe("var(--good)")
    expect(style["backgroundColor"]).toBe("var(--good-soft)")
  })

  test("bare tile has no hover layer", () => {
    const markup = html(<StatTile label="Revenue" value="$1" />)
    expect(markup).not.toContain("group-hover")
    expect(markup).not.toContain("onMouseEnter")
    const nodes = expand(<StatTile label="Revenue" value="$1" icon={<span>i</span>} />)
    expect(textOf(only(nodes))).toContain("i")
  })

  test("merges className", () => {
    expect(html(<StatTile label="Revenue" value="$1" className="ml-2" />)).toContain("ml-2")
  })
})
