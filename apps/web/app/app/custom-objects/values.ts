import type { CustomObjectFieldDef } from "./types"

/**
 * Form-state <-> API-payload conversion for dynamically defined fields.
 *
 * HTML controls only produce strings and booleans, but the API is validated
 * by a zod schema built from the field definitions, which is strict about
 * types (a number field rejects `"4"`). These pure functions are the single
 * place that conversion happens, so the generic form and its tests agree.
 */

/** What a control holds while the user edits. */
export type CustomFieldFormValue = string | boolean | string[]

export type CustomObjectFormState = Record<string, CustomFieldFormValue>

/** Blank state for a field, honouring its definition default. */
export function emptyFormValue(field: CustomObjectFieldDef): CustomFieldFormValue {
  if (field.fieldType === "boolean") {
    return field.defaultValue === true
  }
  if (field.fieldType === "multiselect") {
    return Array.isArray(field.defaultValue) ? field.defaultValue.map(String) : []
  }
  if (field.defaultValue === null || field.defaultValue === undefined) return ""
  return String(field.defaultValue)
}

export function emptyFormState(fields: CustomObjectFieldDef[]): CustomObjectFormState {
  const state: CustomObjectFormState = {}
  for (const field of fields) state[field.key] = emptyFormValue(field)
  return state
}

/** Load a stored payload into form state, falling back to the blank value. */
export function toFormState(
  fields: CustomObjectFieldDef[],
  values: Record<string, unknown>,
): CustomObjectFormState {
  const state: CustomObjectFormState = {}
  for (const field of fields) {
    const stored = values[field.key]
    if (stored === undefined || stored === null) {
      state[field.key] = field.fieldType === "boolean" ? false : emptyBlank(field)
      continue
    }
    if (field.fieldType === "boolean") {
      state[field.key] = stored === true
    } else if (field.fieldType === "multiselect") {
      state[field.key] = Array.isArray(stored) ? stored.map(String) : []
    } else {
      state[field.key] = String(stored)
    }
  }
  return state
}

function emptyBlank(field: CustomObjectFieldDef): CustomFieldFormValue {
  return field.fieldType === "multiselect" ? [] : ""
}

/**
 * Convert form state into the `values` payload. Blank optional fields become
 * `null` (which clears them); blank required fields are reported by
 * `missingRequiredFields` before the request is ever sent.
 */
export function toApiValues(
  fields: CustomObjectFieldDef[],
  state: CustomObjectFormState,
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const field of fields) {
    const raw = state[field.key]
    if (field.fieldType === "boolean") {
      values[field.key] = raw === true
      continue
    }
    if (field.fieldType === "multiselect") {
      const list = Array.isArray(raw) ? raw : []
      values[field.key] = list.length === 0 ? null : list
      continue
    }
    const text = typeof raw === "string" ? raw.trim() : ""
    if (text === "") {
      values[field.key] = null
      continue
    }
    if (field.fieldType === "number") {
      const parsed = Number(text)
      // Keep the raw string when it is not a number: the server's error
      // message is more precise than anything guessed here.
      values[field.key] = Number.isFinite(parsed) ? parsed : text
      continue
    }
    values[field.key] = text
  }
  return values
}

/** Labels of required fields the user has left blank. */
export function missingRequiredFields(
  fields: CustomObjectFieldDef[],
  state: CustomObjectFormState,
): string[] {
  const missing: string[] = []
  for (const field of fields) {
    if (!field.required || field.fieldType === "boolean") continue
    const raw = state[field.key]
    if (field.fieldType === "multiselect") {
      if (!Array.isArray(raw) || raw.length === 0) missing.push(field.label)
      continue
    }
    if (typeof raw !== "string" || raw.trim() === "") missing.push(field.label)
  }
  return missing
}

/** Parse the comma-separated option list used by the field editor. */
export function parseOptionList(input: string): string[] {
  const seen = new Set<string>()
  for (const part of input.split(",")) {
    const trimmed = part.trim()
    if (trimmed !== "") seen.add(trimmed)
  }
  return [...seen]
}
