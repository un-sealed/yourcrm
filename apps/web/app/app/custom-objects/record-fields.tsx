"use client"

import { Checkbox, DatePicker, Field, Select, TextField } from "@yourcrm/ui"
import { optionValuesOf, type CustomObjectFieldDef } from "./types"
import type { CustomFieldFormValue, CustomObjectFormState } from "./values"

/**
 * Generic record form: one control per field definition, chosen by the
 * field's type at render time. There is no per-object form component and no
 * bespoke input — every control is a `@yourcrm/ui` primitive.
 *
 * The server is the authority: this only renders the right control and
 * flags blank required fields. Everything else is validated by the zod
 * schema the API builds from the same definitions.
 */
export function CustomRecordFields({
  fields,
  values,
  onChange,
  disabled = false,
  errors = {},
}: {
  fields: CustomObjectFieldDef[]
  values: CustomObjectFormState
  onChange: (key: string, value: CustomFieldFormValue) => void
  disabled?: boolean
  errors?: Record<string, string>
}) {
  if (fields.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This object has no fields yet. Add one on the object page before creating records.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      {fields.map((field) => {
        const controlId = `custom-field-${field.key}`
        const value = values[field.key]
        return (
          <Field
            key={field.id}
            label={field.label}
            htmlFor={controlId}
            required={field.required}
            error={errors[field.key]}
          >
            <CustomFieldControl
              id={controlId}
              field={field}
              value={value}
              onChange={(next) => onChange(field.key, next)}
              disabled={disabled}
              invalid={errors[field.key] !== undefined}
            />
          </Field>
        )
      })}
    </div>
  )
}

function CustomFieldControl({
  id,
  field,
  value,
  onChange,
  disabled,
  invalid,
}: {
  id: string
  field: CustomObjectFieldDef
  value: CustomFieldFormValue | undefined
  onChange: (value: CustomFieldFormValue) => void
  disabled: boolean
  invalid: boolean
}) {
  const text = typeof value === "string" ? value : ""
  switch (field.fieldType) {
    case "boolean":
      return (
        <Checkbox
          id={id}
          checked={value === true}
          disabled={disabled}
          onChange={(e) => onChange(e.currentTarget.checked)}
        />
      )
    case "date":
      return (
        <DatePicker
          id={id}
          value={text}
          disabled={disabled}
          invalid={invalid}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      )
    case "number":
      return (
        <TextField
          id={id}
          type="number"
          value={text}
          disabled={disabled}
          invalid={invalid}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      )
    case "select":
      return (
        <Select
          id={id}
          value={text}
          disabled={disabled}
          invalid={invalid}
          options={[{ value: "", label: "None" }, ...optionValuesOf(field)]}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      )
    case "multiselect": {
      const selected = Array.isArray(value) ? value : []
      return (
        <div id={id} className="flex flex-wrap gap-3" role="group" aria-label={field.label}>
          {optionValuesOf(field).map((option) => {
            const optionId = `${id}-${option.value}`
            return (
              <label
                key={option.value}
                htmlFor={optionId}
                className="flex items-center gap-2 text-sm"
              >
                <Checkbox
                  id={optionId}
                  checked={selected.includes(option.value)}
                  disabled={disabled}
                  onChange={(e) =>
                    onChange(
                      e.currentTarget.checked
                        ? [...selected, option.value]
                        : selected.filter((entry) => entry !== option.value),
                    )
                  }
                />
                {option.label}
              </label>
            )
          })}
        </div>
      )
    }
    case "email":
    case "url":
      return (
        <TextField
          id={id}
          type={field.fieldType === "email" ? "email" : "url"}
          value={text}
          disabled={disabled}
          invalid={invalid}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      )
    default:
      return (
        <TextField
          id={id}
          value={text}
          disabled={disabled}
          invalid={invalid}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      )
  }
}
