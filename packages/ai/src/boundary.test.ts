import { describe, expect, test } from "bun:test"
import { AI_BOUNDARY_VERSION } from "./index"

describe("ai/boundary", () => {
  test("boundary version is 1 — the placeholder is now the provider contract", () => {
    expect(AI_BOUNDARY_VERSION).toBe(1)
  })
})
