import { describe, expect, test } from "bun:test"
import * as React from "react"
import { WidgetPicker, WidgetPickerList, WidgetPickerRow } from "./widget-picker"
import type { WidgetPickerItem } from "./widget-picker"
import { expand, findAll, html, only, textOf } from "./test-helpers"

const PROFIT: WidgetPickerItem = {
  id: "profit",
  title: "Total Profit",
  description: "Revenue over time",
  tag: "KPI",
}

const ACTIVE: WidgetPickerItem = {
  id: "active",
  title: "Most Day Active",
  description: "Activity by weekday",
  tag: "Chart",
  preview: <span>preview</span>,
}

const WIDGETS: WidgetPickerItem[] = [PROFIT, ACTIVE]

const noop = (): void => undefined

describe("ui/WidgetPicker", () => {
  test("renders nothing when closed", () => {
    const markup = html(
      <WidgetPicker open={false} onClose={noop} widgets={WIDGETS} onSelect={noop} />,
    )
    expect(markup).not.toContain("widget-picker")
  })

  test("passes the controlled contract through to Dialog", () => {
    const seen: string[] = []
    const element = (
      <WidgetPicker
        open={true}
        onClose={noop}
        widgets={WIDGETS}
        onSelect={(id) => {
          seen.push(id)
        }}
      />
    )
    expect(React.isValidElement(element)).toBe(true)
    expect(element.props.open).toBe(true)
    expect(element.props.widgets).toEqual(WIDGETS)
    element.props.onSelect("profit")
    expect(seen).toEqual(["profit"])
  })

  test("forwards className to the dialog panel", () => {
    const element = (
      <WidgetPicker open={true} onClose={noop} widgets={WIDGETS} onSelect={noop} className="ml-2" />
    )
    expect(element.props.className).toBe("ml-2")
  })
})

describe("ui/WidgetPickerList", () => {
  test("renders one row per widget in a scrollable list", () => {
    const node = only(expand(<WidgetPickerList widgets={WIDGETS} onSelect={noop} />))
    expect(node.type).toBe("ul")
    expect(String(node.props["className"] ?? "")).toContain("overflow-y-auto")
    const rows = findAll([node], (child) => child.props["data-slot"] === "widget-picker-item")
    expect(rows).toHaveLength(2)
  })

  test("empty list renders a muted empty state, never bare rows", () => {
    const markup = html(<WidgetPickerList widgets={[]} onSelect={noop} />)
    expect(markup).toContain("No widgets available")
    expect(markup).not.toContain("widget-picker-item")
  })

  test("row Select buttons call onSelect with the widget id", () => {
    const seen: string[] = []
    const node = only(
      expand(
        <WidgetPickerList
          widgets={WIDGETS}
          onSelect={(id) => {
            seen.push(id)
          }}
        />,
      ),
    )
    const buttons = findAll([node], (child) => child.type === "button")
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      const onClick = button.props["onClick"] as () => void
      onClick()
    }
    expect(seen).toEqual(["profit", "active"])
  })
})

describe("ui/WidgetPickerRow", () => {
  test("renders title, description, #tag pill and Select", () => {
    const node = only(expand(<WidgetPickerRow widget={PROFIT} onSelect={noop} />))
    expect(node.type).toBe("li")
    expect(textOf(node)).toContain("Total Profit")
    expect(textOf(node)).toContain("Revenue over time")
    expect(textOf(node)).toContain("#KPI")
    expect(textOf(node)).toContain("Select")
  })

  test("thumbnail uses the surface-2 token and shows the preview when given", () => {
    const markup = html(<WidgetPickerRow widget={ACTIVE} onSelect={noop} />)
    expect(markup).toContain("bg-[var(--surface-2)]")
    expect(markup).toContain("preview")
  })

  test("Select button carries the brand token and a pill radius", () => {
    const node = only(expand(<WidgetPickerRow widget={PROFIT} onSelect={noop} />))
    const button = only(findAll([node], (child) => child.type === "button"))
    const classes = String(button.props["className"] ?? "")
    expect(classes).toContain("bg-[var(--brand)]")
    expect(classes).toContain("rounded-[var(--radius-pill)]")
  })
})
