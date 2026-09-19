import { describe, expect, test } from "bun:test"
import { AGENTS_BOUNDARY_VERSION } from "./index"

describe("agents/boundary", () => {
  test("boundary version is pinned at foundation (0)", () => {
    expect(AGENTS_BOUNDARY_VERSION).toBe(0)
  })
})
