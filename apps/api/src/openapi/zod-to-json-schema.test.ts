import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { zodToJsonSchema } from "./zod-to-json-schema"

describe("openapi/zod-to-json-schema", () => {
  test("converts scalars, enums and literals", () => {
    expect(zodToJsonSchema(z.string().min(1).max(1000))).toEqual({
      type: "string",
      minLength: 1,
      maxLength: 1000,
    })
    expect(zodToJsonSchema(z.number().int())).toEqual({ type: "integer" })
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: "boolean" })
    expect(zodToJsonSchema(z.enum(["a", "b"]))).toEqual({ type: "string", enum: ["a", "b"] })
    expect(zodToJsonSchema(z.literal("pong"))).toEqual({ const: "pong" })
  })

  test("converts objects with required inference", () => {
    const schema = z.object({ message: z.string(), limit: z.number().optional() })
    expect(zodToJsonSchema(schema)).toEqual({
      type: "object",
      properties: { message: { type: "string" }, limit: { type: "number" } },
      required: ["message"],
    })
  })

  test("converts arrays, nullable and unions", () => {
    expect(zodToJsonSchema(z.array(z.string()))).toEqual({
      type: "array",
      items: { type: "string" },
    })
    expect(zodToJsonSchema(z.string().nullable())).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    })
    expect(zodToJsonSchema(z.union([z.string(), z.number()]))).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }],
    })
  })

  test("unknown shapes degrade to an empty schema", () => {
    expect(zodToJsonSchema(z.unknown())).toEqual({})
  })
})
