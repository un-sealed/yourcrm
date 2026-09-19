import { describe, expect, test } from "bun:test"
import * as React from "react"
import { Skeleton } from "./skeleton"
import { expand, html, only } from "./test-helpers"

describe("ui/Skeleton", () => {
  test("renders a pulsing block and merges className", () => {
    const node = only(expand(<Skeleton className="h-4 w-24" />))
    expect(node.type).toBe("div")
    const className = String(node.props["className"] ?? "")
    expect(className).toContain("animate-pulse")
    expect(className).toContain("h-4")
    expect(className).toContain("w-24")
    expect(node.props["aria-hidden"]).toBe("true")
  })

  test("serializes to markup", () => {
    expect(html(<Skeleton className="h-4" />)).toContain("animate-pulse")
  })

  test("is a valid element usable without a wrapper", () => {
    expect(React.isValidElement(<Skeleton />)).toBe(true)
  })
})
