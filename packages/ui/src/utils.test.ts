import { describe, expect, test } from "bun:test"
import { cn } from "./utils"

describe("ui/cn", () => {
  test("merges and dedupes tailwind classes", () => {
    expect(cn("px-4", "px-8")).toBe("px-8")
    expect(cn("text-sm", undefined, false && "hidden")).toBe("text-sm")
  })
})
