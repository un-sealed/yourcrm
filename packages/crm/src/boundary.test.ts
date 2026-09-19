import { describe, expect, test } from "bun:test"
import { CRM_BOUNDARY_VERSION } from "./index"

describe("crm/boundary", () => {
  test("boundary version is pinned at foundation (0)", () => {
    expect(CRM_BOUNDARY_VERSION).toBe(0)
  })
})
