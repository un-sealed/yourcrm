import { describe, expect, test } from "bun:test"
import { errorEnvelope, paginatedEnvelopeSchema, paginationQuerySchema } from "./envelopes"
import { z } from "zod"

describe("validation/envelopes", () => {
  test("pagination query defaults", () => {
    expect(paginationQuerySchema.parse({}).limit).toBe(25)
  })

  test("paginated envelope validates", () => {
    const schema = paginatedEnvelopeSchema(z.object({ id: z.string() }))
    const parsed = schema.parse({
      data: [{ id: "1" }],
      pagination: { nextCursor: null, limit: 25 },
    })
    expect(parsed.data).toHaveLength(1)
  })

  test("error envelope builder", () => {
    expect(errorEnvelope("NOT_FOUND", "missing", "req-1").error.code).toBe("NOT_FOUND")
  })
})
