import { describe, expect, test } from "bun:test"
import { TextArea } from "./text-area"
import { expand, html, only } from "./test-helpers"

describe("ui/TextArea", () => {
  test("renders a textarea with sensible defaults", () => {
    const node = only(expand(<TextArea placeholder="Add a note" />))
    expect(node.type).toBe("textarea")
    expect(node.props["rows"]).toBe(4)
    expect(node.props["placeholder"]).toBe("Add a note")
  })

  test("marks invalid fields with aria-invalid", () => {
    expect(html(<TextArea invalid />)).toContain('aria-invalid="true"')
  })

  test("primary interaction: change handler receives the new value", () => {
    let received = ""
    const node = only(
      expand(
        <TextArea
          value={received}
          onChange={(event) => {
            received = event.currentTarget.value
          }}
        />,
      ),
    )
    const onChange = node.props["onChange"] as (event: { currentTarget: { value: string } }) => void
    onChange({ currentTarget: { value: "Called twice, no answer." } })
    expect(received).toBe("Called twice, no answer.")
  })
})
