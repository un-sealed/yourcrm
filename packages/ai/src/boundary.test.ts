import { describe, expect, test } from "bun:test"
import { AI_BOUNDARY_VERSION } from "./index"

describe("ai/boundary", () => {
  test("boundary version is pinned at foundation (0)", () => {
    expect(AI_BOUNDARY_VERSION).toBe(0)
  })
})
