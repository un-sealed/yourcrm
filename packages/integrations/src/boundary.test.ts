import { describe, expect, test } from "bun:test"
import { INTEGRATION_CAPABILITIES, INTEGRATIONS_BOUNDARY_VERSION } from "./index"

describe("integrations/boundary", () => {
  test("boundary version moved off the placeholder", () => {
    expect(INTEGRATIONS_BOUNDARY_VERSION).toBe(1)
  })

  test("capabilities cover the P0 downstream modules", () => {
    for (const capability of ["email.send", "messaging.send", "calling.place"] as const) {
      expect(INTEGRATION_CAPABILITIES).toContain(capability)
    }
  })
})
