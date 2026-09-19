import { describe, expect, test } from "bun:test"
import { Checkbox } from "./checkbox"
import { expand, html, only } from "./test-helpers"

describe("ui/Checkbox", () => {
  test("renders a native checkbox", () => {
    const node = only(expand(<Checkbox aria-label="Select row" />))
    expect(node.type).toBe("input")
    expect(node.props["type"]).toBe("checkbox")
  })

  test("indeterminate state is exposed to assistive tech", () => {
    expect(html(<Checkbox indeterminate aria-label="Select all" />)).toContain(
      'aria-checked="mixed"',
    )
    expect(html(<Checkbox aria-label="Select all" />)).not.toContain("aria-checked")
  })

  test("primary interaction: change handler fires on toggle", () => {
    const checked: { value: boolean | null } = { value: null }
    const node = only(
      expand(
        <Checkbox
          onChange={(event) => {
            checked.value = event.currentTarget.checked
          }}
        />,
      ),
    )
    const onChange = node.props["onChange"] as (event: {
      currentTarget: { checked: boolean }
    }) => void
    onChange({ currentTarget: { checked: true } })
    expect(checked.value).toBe(true)
  })
})
