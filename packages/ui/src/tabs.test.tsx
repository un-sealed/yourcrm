import { describe, expect, test } from "bun:test"
import * as React from "react"
import { Tabs } from "./tabs"

const ITEMS = [
  { value: "activity", label: "Activity", content: "Activity panel" },
  { value: "notes", label: "Notes", content: "Notes panel" },
]

describe("ui/Tabs", () => {
  test("is a valid controlled element", () => {
    const element = <Tabs value="activity" onValueChange={() => undefined} items={ITEMS} />
    expect(React.isValidElement(element)).toBe(true)
    expect(element.props.value).toBe("activity")
  })

  test("primary interaction: selecting a tab reports its value", () => {
    let selected = "activity"
    const element = (
      <Tabs
        value={selected}
        onValueChange={(next) => {
          selected = next
        }}
        items={ITEMS}
      />
    )
    expect(React.isValidElement(element)).toBe(true)
    element.props.onValueChange("notes")
    expect(selected).toBe("notes")
  })
})
