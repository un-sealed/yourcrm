import { describe, expect, test } from "bun:test"
import { DatePicker } from "./date-picker"
import { expand, html, only } from "./test-helpers"

describe("ui/DatePicker", () => {
  test("renders a native date input", () => {
    const node = only(expand(<DatePicker aria-label="Close date" />))
    expect(node.type).toBe("input")
    expect(node.props["type"]).toBe("date")
  })

  test("marks invalid fields with aria-invalid", () => {
    expect(html(<DatePicker invalid />)).toContain('aria-invalid="true"')
  })

  test("primary interaction: change handler receives the picked date", () => {
    let received = ""
    const node = only(
      expand(
        <DatePicker
          value={received}
          onChange={(event) => {
            received = event.currentTarget.value
          }}
        />,
      ),
    )
    const onChange = node.props["onChange"] as (event: { currentTarget: { value: string } }) => void
    onChange({ currentTarget: { value: "2026-03-31" } })
    expect(received).toBe("2026-03-31")
  })
})
