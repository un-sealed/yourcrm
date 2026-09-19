import { describe, expect, test } from "bun:test"
import { Timeline } from "./timeline"
import { expand, findAll, html, only, textOf } from "./test-helpers"

const ITEMS = [
  {
    id: "e1",
    icon: "✉",
    actor: "Ada Lovelace",
    timestamp: "2 hours ago",
    dateTime: "2026-09-19T08:00:00Z",
    body: "Sent proposal email.",
  },
  { id: "e2", actor: "System", timestamp: "Yesterday", body: "Deal stage changed." },
]

describe("ui/Timeline", () => {
  test("renders items in order with actor, time and body", () => {
    const node = only(expand(<Timeline items={ITEMS} />))
    expect(node.type).toBe("ol")
    const items = findAll([node], (candidate) => candidate.props["data-slot"] === "timeline-item")
    expect(items.length).toBe(2)
    const first = items[0] as (typeof items)[number]
    expect(textOf(first)).toContain("Ada Lovelace")
    expect(textOf(first)).toContain("Sent proposal email.")
    expect(textOf(node).indexOf("Sent proposal")).toBeLessThan(
      textOf(node).indexOf("Deal stage changed."),
    )
  })

  test("timestamps use the time element with machine-readable dates", () => {
    const markup = html(<Timeline items={ITEMS} />)
    expect(markup).toContain("<time")
    expect(markup).toContain("2026-09-19T08:00:00Z")
  })

  test("primary interaction: body slots render arbitrary content", () => {
    const node = only(
      expand(
        <Timeline
          items={[
            {
              id: "e1",
              timestamp: "now",
              body: <button type="button">View attachment</button>,
            },
          ]}
        />,
      ),
    )
    const buttons = findAll([node], (candidate) => candidate.type === "button")
    expect(buttons.length).toBe(1)
    expect(textOf(node)).toContain("View attachment")
  })
})
