import { describe, expect, test } from "bun:test"
import { INTEGRATIONS_BOUNDARY_VERSION } from "./index"

describe("integrations/boundary", () => {
  test("boundary version is pinned at foundation (0)", () => {
    expect(INTEGRATIONS_BOUNDARY_VERSION).toBe(0)
  })
})
