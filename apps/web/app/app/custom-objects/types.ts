import type { FilterFieldDef, FilterFieldType } from "@yourcrm/ui"

/**
 * Wire types for the custom-objects API (`/api/v1/custom-objects`).
 *
 * Everything here is generic on purpose: the pages render whatever object
 * types and fields the workspace has defined, so there is no per-object
 * component. Values arrive as `unknown` and are narrowed before display.
 */

export type CustomObjectSummary = {
  id: string
  workspaceId: string
  slug: string
  name: string
  pluralName: string
  icon: string | null
  description: string | null
  createdAt: string
  updatedAt: string
}

export const CUSTOM_OBJECT_FIELD_TYPE_OPTIONS = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "select", label: "Select" },
  { value: "multiselect", label: "Multi-select" },
  { value: "boolean", label: "Checkbox" },
  { value: "url", label: "URL" },
  { value: "email", label: "Email" },
]

export type CustomObjectFieldOption = string | { value: string; label?: string }

export type CustomObjectFieldDef = {
  id: string
  objectType: string
  key: string
  label: string
  fieldType: string
  options: CustomObjectFieldOption[] | null
  defaultValue: unknown
  required: boolean
  displayOrder: number
}

export type CustomObjectRecord = {
  id: string
  workspaceId: string
  objectId: string
  ownerId: string | null
  displayName: string
  fieldValues: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type CustomObjectDetail = CustomObjectSummary & { fields: CustomObjectFieldDef[] }

export type CustomObjectRecordDetail = CustomObjectRecord & {
  object: CustomObjectSummary
  fields: CustomObjectFieldDef[]
}

export type CustomObjectListResponse = {
  data: CustomObjectSummary[]
  pagination: { nextCursor: string | null; limit: number }
}

export type CustomObjectRecordListResponse = {
  data: CustomObjectRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

/** Option values of a select/multiselect definition, in display order. */
export function optionValuesOf(field: CustomObjectFieldDef): { value: string; label: string }[] {
  if (!field.options) return []
  return field.options.map((option) =>
    typeof option === "string"
      ? { value: option, label: option }
      : { value: option.value, label: option.label ?? option.value },
  )
}

/** Render a stored value for a table cell or a read-only row. */
export function formatCustomFieldValue(field: CustomObjectFieldDef, value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (Array.isArray(value)) {
    const labels = optionValuesOf(field)
    return value
      .map((entry) => {
        const match = labels.find((option) => option.value === entry)
        return match?.label ?? String(entry)
      })
      .join(", ")
  }
  if (field.fieldType === "select") {
    const match = optionValuesOf(field).find((option) => option.value === value)
    if (match) return match.label
  }
  if (typeof value === "number") return String(value)
  if (typeof value === "string") return value === "" ? "—" : value
  return JSON.stringify(value)
}

/** Field types the shared FilterBuilder understands, per custom field type. */
export function filterTypeOf(fieldType: string): FilterFieldType {
  switch (fieldType) {
    case "number":
      return "number"
    case "date":
      return "date"
    case "boolean":
      return "boolean"
    case "select":
    case "multiselect":
      return "select"
    default:
      return "text"
  }
}

/** Build FilterBuilder field definitions from the object's own fields. */
export function toFilterFields(fields: CustomObjectFieldDef[]): FilterFieldDef[] {
  return fields.map((field) => {
    const options = optionValuesOf(field)
    return {
      name: field.key,
      label: field.label,
      type: filterTypeOf(field.fieldType),
      ...(options.length > 0 ? { options } : {}),
    }
  })
}
