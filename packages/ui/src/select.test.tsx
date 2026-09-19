import { describe, expect, test } from "bun:test"
import { Select } from "./select"
import { expand, findAll, html, only, textOf } from "./test-helpers"

const OPTIONS = [
  { value: "new", label: "New" },
  { value: "won", label: "Won" },
]

describe("ui/Select", () => {
  test("renders options with labels", () => {
    const node = only(expand(<Select options={OPTIONS} aria-label="Stage" />))
    expect(node.type).toBe("select")
    const renderedOptions = findAll([node], (candidate) => candidate.type === "option")
    expect(renderedOptions.map((option) => textOf(option))).toEqual(["New", "Won"])
  })

  test("renders a placeholder entry when requested", () => {
    expect(html(<Select options={OPTIONS} placeholder="Pick a stage" />)).toContain("Pick a stage")
  })

  test("primary interaction: change handler receives the selected value", () => {
    let received = ""
    const node = only(
      expand(
        <Select
          options={OPTIONS}
          value={received}
          onChange={(event) => {
            received = event.currentTarget.value
          }}
        />,
      ),
    )
    const onChange = node.props["onChange"] as (event: { currentTarget: { value: string } }) => void
    onChange({ currentTarget: { value: "won" } })
    expect(received).toBe("won")
  })
})
