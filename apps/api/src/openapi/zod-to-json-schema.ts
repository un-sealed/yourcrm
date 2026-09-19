import { z } from "zod"

/**
 * Minimal zod-to-JSON-schema pass for `/openapi.json`. Module routers expose
 * zod schemas at their boundaries; this converts the common shapes to plain
 * JSON Schema so no extra dependency is needed. Unknown/complex schemas
 * degrade to `{}` rather than failing the document build.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as { typeName: string } & Record<string, unknown>

  switch (def.typeName) {
    case "ZodString": {
      const out: Record<string, unknown> = { type: "string" }
      const checks = (def.checks ?? []) as { kind: string; value?: unknown }[]
      for (const check of checks) {
        if (check.kind === "min") out.minLength = check.value
        if (check.kind === "max") out.maxLength = check.value
        if (check.kind === "email") out.format = "email"
        if (check.kind === "uuid") out.format = "uuid"
      }
      return out
    }
    case "ZodNumber": {
      const out: Record<string, unknown> = { type: "number" }
      const checks = (def.checks ?? []) as { kind: string; value?: unknown }[]
      for (const check of checks) {
        if (check.kind === "min") out.minimum = check.value
        if (check.kind === "max") out.maximum = check.value
        if (check.kind === "int") out.type = "integer"
      }
      return out
    }
    case "ZodBoolean":
      return { type: "boolean" }
    case "ZodEnum":
      return { type: "string", enum: (def.values ?? []) as unknown[] }
    case "ZodLiteral":
      return { const: def.value as unknown }
    case "ZodArray":
      return { type: "array", items: zodToJsonSchema(def.type as z.ZodTypeAny) }
    case "ZodObject": {
      const shape = (def.shape as () => Record<string, z.ZodTypeAny>)()
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const [key, field] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(field)
        if (!isOptional(field)) required.push(key)
      }
      const out: Record<string, unknown> = { type: "object", properties }
      if (required.length > 0) out.required = required
      return out
    }
    case "ZodOptional":
    case "ZodDefault": {
      const inner = zodToJsonSchema(def.innerType as z.ZodTypeAny)
      return def.typeName === "ZodDefault"
        ? { ...inner, default: def.defaultValue as unknown }
        : inner
    }
    case "ZodNullable":
      return { anyOf: [zodToJsonSchema(def.innerType as z.ZodTypeAny), { type: "null" }] }
    case "ZodEffects":
      return zodToJsonSchema(def.schema as z.ZodTypeAny)
    case "ZodUnion":
      return { anyOf: (def.options as z.ZodTypeAny[]).map(zodToJsonSchema) }
    default:
      return {}
  }
}

function isOptional(schema: z.ZodTypeAny): boolean {
  const typeName = (schema._def as { typeName: string }).typeName
  return typeName === "ZodOptional" || typeName === "ZodDefault"
}
