import { describe, expect, test } from "bun:test"
import { BulkBar } from "./bulk-bar"
import { expand, findAll, html, only, textOf } from "./test-helpers"

describe("ui/BulkBar", () => {
  test("renders nothing without a selection", () => {
    expect(html(<BulkBar selectedCount={0}>{"actions"}</BulkBar>)).toBe("")
  })

  test("shows the selected count and action slot", () => {
    const node = only(
      expand(
        <BulkBar selectedCount={3} onClear={() => undefined}>
          <button type="button">Delete</button>
        </BulkBar>,
      ),
    )
    expect(node.props["role"]).toBe("toolbar")
    expect(textOf(node)).toContain("3 selected")
    const buttons = findAll([node], (candidate) => candidate.type === "button")
    expect(buttons.length).toBe(2)
  })

  test("primary interaction: clear button invokes onClear", () => {
    let calls = 0
    const node = only(
      expand(
        <BulkBar
          selectedCount={2}
          onClear={() => {
            calls += 1
          }}
        />,
      ),
    )
    const buttons = findAll([node], (candidate) => candidate.type === "button")
    const button = buttons[0] as (typeof buttons)[number] | undefined
    ;(button?.props["onClick"] as () => void)()
    expect(calls).toBe(1)
  })
})
