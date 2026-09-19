import { describe, expect, test } from "bun:test"
import { WORKFLOWS_BOUNDARY_VERSION } from "./index"

describe("workflows/boundary", () => {
  test("boundary version is pinned at foundation (0)", () => {
    expect(WORKFLOWS_BOUNDARY_VERSION).toBe(0)
  })
})
