import { describe, expect, test } from "bun:test"
import { EmptyState } from "./empty-state"
import { expand, findAll, html, only, textOf } from "./test-helpers"

describe("ui/EmptyState", () => {
  test("renders title, description and action", () => {
    const node = only(
      expand(
        <EmptyState
          title="No contacts yet"
          description="Import your first contacts to get started."
          action={<button type="button">Add contact</button>}
        />,
      ),
    )
    expect(node.type).toBe("div")
    expect(textOf(node)).toContain("No contacts yet")
    expect(textOf(node)).toContain("Import your first contacts")
    const buttons = findAll([node], (candidate) => candidate.type === "button")
    expect(buttons.length).toBe(1)
  })

  test("omits optional slots when not provided", () => {
    const markup = html(<EmptyState title="Nothing here" />)
    expect(markup).toContain("Nothing here")
    expect(markup).not.toContain("<button")
  })

  test("primary interaction: action button invokes its handler", () => {
    let calls = 0
    const node = only(
      expand(
        <EmptyState
          title="Empty"
          action={
            <button
              type="button"
              onClick={() => {
                calls += 1
              }}
            >
              Create
            </button>
          }
        />,
      ),
    )
    const buttons = findAll([node], (candidate) => candidate.type === "button")
    const button = buttons[0] as (typeof buttons)[number] | undefined
    expect(button).toBeDefined()
    ;(button?.props["onClick"] as () => void)()
    expect(calls).toBe(1)
  })
})
