import { describe, expect, test } from "bun:test"
import { Button } from "./button"
import { expand, html, only, textOf } from "./test-helpers"

describe("ui/Button", () => {
  test("renders a button with variant classes", () => {
    const node = only(expand(<Button variant="destructive">Delete</Button>))
    expect(node.type).toBe("button")
    expect(node.props["type"]).toBe("button")
    expect(textOf(node)).toBe("Delete")
    expect(String(node.props["className"] ?? "")).toContain("bg-destructive")
  })

  test("primary interaction: click handler fires", () => {
    let calls = 0
    const node = only(
      expand(
        <Button
          onClick={() => {
            calls += 1
          }}
        >
          Save
        </Button>,
      ),
    )
    ;(node.props["onClick"] as () => void)()
    expect(calls).toBe(1)
  })

  test("serializes with merged classes", () => {
    expect(html(<Button size="sm">Hi</Button>)).toContain("h-8")
  })
})
