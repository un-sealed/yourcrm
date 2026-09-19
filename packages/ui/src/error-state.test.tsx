import { describe, expect, test } from "bun:test"
import { ErrorState } from "./error-state"
import { expand, findAll, html, only, textOf } from "./test-helpers"

describe("ui/ErrorState", () => {
  test("renders as an alert with the message", () => {
    const node = only(expand(<ErrorState message="Failed to load contacts." />))
    expect(node.type).toBe("div")
    expect(node.props["role"]).toBe("alert")
    expect(textOf(node)).toContain("Failed to load contacts.")
  })

  test("shows no retry button without onRetry", () => {
    expect(html(<ErrorState message="Broken" />)).not.toContain("<button")
  })

  test("primary interaction: retry button invokes onRetry", () => {
    let calls = 0
    const node = only(
      expand(
        <ErrorState
          message="Broken"
          retryLabel="Reload"
          onRetry={() => {
            calls += 1
          }}
        />,
      ),
    )
    expect(textOf(node)).toContain("Reload")
    const buttons = findAll([node], (candidate) => candidate.type === "button")
    expect(buttons.length).toBe(1)
    const button = buttons[0] as (typeof buttons)[number] | undefined
    ;(button?.props["onClick"] as () => void)()
    expect(calls).toBe(1)
  })
})
