"use client"

import {
  Button,
  Checkbox,
  Field,
  FilterBuilder,
  Select,
  TextArea,
  TextField,
  emptyFilterTree,
  type FilterTree,
} from "@yourcrm/ui"
import {
  AGGREGATE_OPTIONS,
  VISIBILITY_OPTIONS,
  toFieldOptions,
  toFilterFields,
  type ReportAggregateFunction,
  type ReportAggregation,
  type ReportColumn,
  type ReportObjectCatalogEntry,
  type ReportSort,
} from "./types"

/** Editable shape of a report definition (create and edit share it). */
export type ReportDraft = {
  name: string
  description: string
  objectType: string
  visibility: string
  filter: FilterTree
  groupBy: string
  aggregations: ReportAggregation[]
  columns: ReportColumn[]
  sort: ReportSort[]
  rowLimit: number
}

export function emptyDraft(objectType = ""): ReportDraft {
  return {
    name: "",
    description: "",
    objectType,
    visibility: "shared",
    filter: emptyFilterTree(),
    groupBy: "",
    aggregations: [],
    columns: [],
    sort: [],
    rowLimit: 100,
  }
}

/** Request body for POST/PATCH `/api/v1/reports`. */
export function draftToBody(draft: ReportDraft): Record<string, unknown> {
  const grouped = draft.groupBy !== "" || draft.aggregations.length > 0
  return {
    name: draft.name.trim(),
    description: draft.description.trim() === "" ? null : draft.description.trim(),
    objectType: draft.objectType,
    visibility: draft.visibility,
    filter: draft.filter.children.length === 0 ? null : draft.filter,
    groupBy: draft.groupBy === "" ? null : draft.groupBy,
    aggregations: draft.aggregations.length === 0 ? null : draft.aggregations,
    columns: grouped || draft.columns.length === 0 ? null : draft.columns,
    sort: draft.sort.length === 0 ? null : draft.sort,
    rowLimit: draft.rowLimit,
  }
}

/** Result keys a definition can be sorted by (dimension + metric keys). */
export function sortableKeys(draft: ReportDraft): { value: string; label: string }[] {
  const grouped = draft.groupBy !== "" || draft.aggregations.length > 0
  if (!grouped) {
    return draft.columns.map((column) => ({ value: column.field, label: column.field }))
  }
  const keys: { value: string; label: string }[] = []
  if (draft.groupBy !== "") keys.push({ value: draft.groupBy, label: draft.groupBy })
  const metrics = draft.aggregations.length > 0 ? draft.aggregations : [{ fn: "count" as const }]
  for (const metric of metrics) {
    const key = metric.field ? `${metric.fn}_${metric.field}` : "count"
    keys.push({ value: key, label: key })
  }
  return keys
}

export interface ReportBuilderProps {
  catalogue: ReportObjectCatalogEntry[]
  value: ReportDraft
  onChange: (draft: ReportDraft) => void
  /** Object type is fixed once the report exists (results would change shape). */
  lockObjectType?: boolean
}

/**
 * Report definition builder. Every input is bound to the allowlist the API
 * publishes at `/api/v1/reports/objects`, so the UI can only compose
 * definitions the server is willing to execute.
 */
export function ReportBuilder({
  catalogue,
  value,
  onChange,
  lockObjectType = false,
}: ReportBuilderProps) {
  const entry = catalogue.find((object) => object.objectType === value.objectType)
  const filterFields = toFilterFields(entry)
  const allFields = toFieldOptions(entry)
  const numericFields = toFieldOptions(entry, (type) => type === "number")
  const grouped = value.groupBy !== "" || value.aggregations.length > 0

  const patch = (next: Partial<ReportDraft>) => onChange({ ...value, ...next })

  const setAggregation = (index: number, next: Partial<ReportAggregation>) => {
    patch({
      aggregations: value.aggregations.map((item, i) =>
        i === index ? { ...item, ...next } : item,
      ),
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Report name" htmlFor="report-name" required>
          <TextField
            id="report-name"
            value={value.name}
            onChange={(event) => patch({ name: event.currentTarget.value })}
            placeholder="Open deals by stage"
            required
          />
        </Field>
        <Field label="Reports on" htmlFor="report-object">
          <Select
            id="report-object"
            value={value.objectType}
            disabled={lockObjectType}
            onChange={(event) =>
              patch({
                objectType: event.currentTarget.value,
                // Fields belong to an object: reset everything derived.
                filter: emptyFilterTree(),
                groupBy: "",
                aggregations: [],
                columns: [],
                sort: [],
              })
            }
            options={[
              { value: "", label: "Choose an object…" },
              ...catalogue.map((object) => ({
                value: object.objectType,
                label: object.label,
              })),
            ]}
          />
        </Field>
      </div>

      <Field label="Description" htmlFor="report-description">
        <TextArea
          id="report-description"
          value={value.description}
          onChange={(event) => patch({ description: event.currentTarget.value })}
          placeholder="What question does this report answer?"
        />
      </Field>

      <section aria-label="Filters" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Filters</h2>
        <FilterBuilder
          value={value.filter}
          onChange={(filter) => patch({ filter })}
          fields={filterFields}
        />
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Group by" htmlFor="report-group">
          <Select
            id="report-group"
            value={value.groupBy}
            onChange={(event) => patch({ groupBy: event.currentTarget.value, sort: [] })}
            options={[{ value: "", label: "No grouping" }, ...allFields]}
          />
        </Field>
        <Field label="Row limit" htmlFor="report-limit">
          <TextField
            id="report-limit"
            type="number"
            min={1}
            max={500}
            value={String(value.rowLimit)}
            onChange={(event) =>
              patch({
                rowLimit: Math.min(Math.max(Number(event.currentTarget.value) || 1, 1), 500),
              })
            }
          />
        </Field>
      </div>

      <section aria-label="Metrics" className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Metrics</h2>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={value.aggregations.length >= 5}
            onClick={() =>
              patch({ aggregations: [...value.aggregations, { fn: "count" }], sort: [] })
            }
          >
            Add metric
          </Button>
        </div>
        {value.aggregations.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No metrics: the report lists records as a table.
          </p>
        ) : null}
        {value.aggregations.map((aggregation, index) => (
          <div
            key={`${aggregation.fn}-${String(index)}`}
            className="flex flex-wrap items-end gap-2"
          >
            <Field label="Function" htmlFor={`metric-fn-${String(index)}`}>
              <Select
                id={`metric-fn-${String(index)}`}
                className="w-40"
                value={aggregation.fn}
                onChange={(event) =>
                  setAggregation(index, {
                    fn: event.currentTarget.value as ReportAggregateFunction,
                  })
                }
                options={AGGREGATE_OPTIONS}
              />
            </Field>
            <Field label="Field" htmlFor={`metric-field-${String(index)}`}>
              <Select
                id={`metric-field-${String(index)}`}
                className="w-48"
                value={aggregation.field ?? ""}
                onChange={(event) =>
                  setAggregation(index, {
                    field: event.currentTarget.value === "" ? null : event.currentTarget.value,
                  })
                }
                options={[
                  { value: "", label: aggregation.fn === "count" ? "All rows" : "Choose a field…" },
                  ...(aggregation.fn === "sum" || aggregation.fn === "avg"
                    ? numericFields
                    : allFields),
                ]}
              />
            </Field>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                patch({
                  aggregations: value.aggregations.filter((_, i) => i !== index),
                  sort: [],
                })
              }
            >
              Remove
            </Button>
          </div>
        ))}
      </section>

      {!grouped ? (
        <section aria-label="Columns" className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Columns</h2>
          <div className="flex flex-wrap gap-3">
            {allFields.map((option) => {
              const checked = value.columns.some((column) => column.field === option.value)
              return (
                <label
                  key={option.value}
                  htmlFor={`column-${option.value}`}
                  className="flex items-center gap-2 text-sm"
                >
                  <Checkbox
                    id={`column-${option.value}`}
                    checked={checked}
                    onChange={() =>
                      patch({
                        columns: checked
                          ? value.columns.filter((column) => column.field !== option.value)
                          : [...value.columns, { field: option.value }],
                        sort: [],
                      })
                    }
                  />
                  {option.label}
                </label>
              )
            })}
          </div>
          {value.columns.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No columns selected: the server picks a sensible default set.
            </p>
          ) : null}
        </section>
      ) : null}

      <section aria-label="Sorting" className="flex flex-wrap items-end gap-2">
        <Field label="Sort by" htmlFor="report-sort-field">
          <Select
            id="report-sort-field"
            className="w-56"
            value={value.sort[0]?.field ?? ""}
            onChange={(event) =>
              patch({
                sort:
                  event.currentTarget.value === ""
                    ? []
                    : [
                        {
                          field: event.currentTarget.value,
                          direction: value.sort[0]?.direction ?? "desc",
                        },
                      ],
              })
            }
            options={[{ value: "", label: "Default order" }, ...sortableKeys(value)]}
          />
        </Field>
        <Field label="Direction" htmlFor="report-sort-direction">
          <Select
            id="report-sort-direction"
            className="w-36"
            value={value.sort[0]?.direction ?? "desc"}
            disabled={value.sort.length === 0}
            onChange={(event) =>
              patch({
                sort: value.sort.map((entry) => ({
                  ...entry,
                  direction: event.currentTarget.value === "asc" ? "asc" : "desc",
                })),
              })
            }
            options={[
              { value: "desc", label: "Descending" },
              { value: "asc", label: "Ascending" },
            ]}
          />
        </Field>
        <Field label="Visibility" htmlFor="report-visibility">
          <Select
            id="report-visibility"
            className="w-64"
            value={value.visibility}
            onChange={(event) => patch({ visibility: event.currentTarget.value })}
            options={VISIBILITY_OPTIONS}
          />
        </Field>
      </section>
    </div>
  )
}
