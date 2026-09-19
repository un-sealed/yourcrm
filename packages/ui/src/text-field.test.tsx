import { describe, expect, test } from "bun:test"
import { TextField } from "./text-field"
import { expand, html, only } from "./test-helpers"

describe("ui/TextField", () => {
  test("renders an input with merged classes", () => {
    const node = only(expand(<TextField placeholder="Search contacts" className="w-64" />))
    expect(node.type).toBe("input")
    expect(node.props["placeholder"]).toBe("Search contacts")
    expect(String(node.props["className"] ?? "")).toContain("w-64")
  })

  test("marks invalid fields with aria-invalid", () => {
    expect(html(<TextField invalid />)).toContain('aria-invalid="true"')
    expect(html(<TextField />)).not.toContain("aria-invalid")
  })

  test("primary interaction: change handler receives the new value", () => {
    let received = ""
    const node = only(
      expand(
        <TextField
          value={received}
          onChange={(event) => {
            received = event.currentTarget.value
          }}
        />,
      ),
    )
    const onChange = node.props["onChange"] as (event: { currentTarget: { value: string } }) => void
    onChange({ currentTarget: { value: "Acme" } })
    expect(received).toBe("Acme")
  })
})
