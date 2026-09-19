import { describe, expect, test } from "bun:test"
import { Field } from "./field"
import { expand, html, only, textOf } from "./test-helpers"

describe("ui/Field", () => {
  test("renders label associated with the control", () => {
    const node = only(
      expand(
        <Field label="Company" htmlFor="company" hint="Legal name">
          <input id="company" type="text" />
        </Field>,
      ),
    )
    expect(textOf(node)).toContain("Company")
    expect(html(<Field label="Company" htmlFor="company" hint="Legal name" />)).toContain(
      'for="company"',
    )
  })

  test("exposes error text as an alert", () => {
    const markup = html(
      <Field label="Email" htmlFor="email" error="Enter a valid email.">
        <input id="email" type="email" />
      </Field>,
    )
    expect(markup).toContain('role="alert"')
    expect(markup).toContain("Enter a valid email.")
  })

  test("primary interaction: required marker is text, not color alone", () => {
    const markup = html(
      <Field label="Name" htmlFor="name" required>
        <input id="name" type="text" />
      </Field>,
    )
    expect(markup).toContain("(required)")
  })
})
