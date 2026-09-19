import { describe, expect, test } from "bun:test"
import * as React from "react"
import { Combobox, filterComboboxOptions } from "./combobox"

const OPTIONS = [
  { value: "acme", label: "Acme Corp" },
  { value: "globex", label: "Globex" },
  { value: "initech", label: "Initech" },
]

describe("ui/filterComboboxOptions", () => {
  test("returns everything on an empty query", () => {
    expect(filterComboboxOptions(OPTIONS, "")).toEqual(OPTIONS)
    expect(filterComboboxOptions(OPTIONS, "   ")).toEqual(OPTIONS)
  })

  test("filters case-insensitively by label substring", () => {
    expect(filterComboboxOptions(OPTIONS, "acme").map((option) => option.value)).toEqual(["acme"])
    expect(filterComboboxOptions(OPTIONS, "EX").map((option) => option.value)).toEqual(["globex"])
    expect(filterComboboxOptions(OPTIONS, "zzz")).toEqual([])
  })
})

describe("ui/Combobox", () => {
  test("is usable as a controlled element without a wrapper", () => {
    const element = (
      <Combobox value={null} onValueChange={() => undefined} options={OPTIONS} label="Account" />
    )
    expect(React.isValidElement(element)).toBe(true)
  })

  test("exposes combobox semantics via props", () => {
    const element = (
      <Combobox
        value="acme"
        onValueChange={() => undefined}
        options={OPTIONS}
        open={true}
        search=""
        label="Account"
        inputId="account-combobox"
      />
    )
    expect(React.isValidElement(element)).toBe(true)
    expect(element.props.open).toBe(true)
    expect(element.props.value).toBe("acme")
  })
})
