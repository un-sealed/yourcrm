import { describe, expect, test } from "bun:test"
import { Badge } from "./badge"
import { expand, html, only, textOf } from "./test-helpers"

describe("ui/Badge", () => {
  test("renders label text with the requested tone", () => {
    const node = only(expand(<Badge tone="success">Won</Badge>))
    expect(node.type).toBe("span")
    expect(textOf(node)).toBe("Won")
    expect(String(node.props["className"] ?? "")).toContain("emerald")
  })

  test("every tone serializes with a visible label (never color alone)", () => {
    for (const tone of [
      "default",
      "secondary",
      "outline",
      "success",
      "warning",
      "info",
      "destructive",
    ] as const) {
      const markup = html(<Badge tone={tone}>{tone}</Badge>)
      expect(markup).toContain(tone)
    }
  })

  test("merges className", () => {
    expect(html(<Badge className="ml-2">X</Badge>)).toContain("ml-2")
  })
})
