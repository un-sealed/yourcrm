import { describe, expect, test } from "bun:test"
import { Avatar, getInitials } from "./avatar"
import { expand, html, only, textOf } from "./test-helpers"

describe("ui/getInitials", () => {
  test("derives initials from first and last name", () => {
    expect(getInitials("Ada Lovelace")).toBe("AL")
    expect(getInitials("  ada   lovelace  ")).toBe("AL")
    expect(getInitials("Madonna")).toBe("MA")
    expect(getInitials("")).toBe("?")
  })
})

describe("ui/Avatar", () => {
  test("renders initials fallback with an accessible name", () => {
    const node = only(expand(<Avatar name="Ada Lovelace" />))
    expect(node.type).toBe("div")
    expect(textOf(node)).toContain("AL")
    expect(node.props["aria-label"]).toBe("Ada Lovelace")
    expect(node.props["role"]).toBe("img")
  })

  test("renders an image when src is provided", () => {
    const markup = html(<Avatar name="Ada Lovelace" src="https://example.com/ada.png" />)
    expect(markup).toContain("<img")
    expect(markup).toContain("https://example.com/ada.png")
  })

  test("primary interaction: size variant changes layout classes", () => {
    expect(html(<Avatar name="Al" size="sm" />)).toContain("h-6")
    expect(html(<Avatar name="Al" size="lg" />)).toContain("h-10")
  })
})
