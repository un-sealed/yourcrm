import { describe, expect, test } from "bun:test"
import {
  describeReport,
  formatCell,
  toFieldOptions,
  toFilterFields,
  type ReportObjectCatalogEntry,
} from "./types"

const CATALOGUE: ReportObjectCatalogEntry[] = [
  {
    objectType: "deal",
    label: "Deals",
    fields: [
      { name: "name", label: "Name", type: "text" },
      { name: "amount", label: "Amount", type: "number" },
      { name: "stage", label: "Stage", type: "select", options: ["won", "lost"] },
    ],
  },
]

describe("reports/types", () => {
  test("toFilterFields adapts the catalogue to the shared FilterBuilder contract", () => {
    const fields = toFilterFields(CATALOGUE[0])
    expect(fields.map((f) => f.name)).toEqual(["name", "amount", "stage"])
    expect(fields[1]?.type).toBe("number")
    expect(fields[2]?.options).toEqual([
      { value: "won", label: "won" },
      { value: "lost", label: "lost" },
    ])
    expect(toFilterFields(undefined)).toEqual([])
  })

  test("unknown server field types fall back to text instead of breaking the builder", () => {
    const fields = toFilterFields({
      objectType: "x",
      label: "X",
      fields: [{ name: "weird", label: "Weird", type: "geography" }],
    })
    expect(fields[0]?.type).toBe("text")
  })

  test("toFieldOptions can narrow to a field type (numeric aggregates)", () => {
    expect(toFieldOptions(CATALOGUE[0], (type) => type === "number")).toEqual([
      { value: "amount", label: "Amount" },
    ])
    expect(toFieldOptions(undefined)).toEqual([])
  })

  test("describeReport summarises the definition in human terms", () => {
    expect(
      describeReport(
        { objectType: "deal", groupBy: "stage", aggregations: [{ fn: "count" }] },
        CATALOGUE,
      ),
    ).toBe("Count — Deals by Stage")
    expect(
      describeReport(
        { objectType: "deal", groupBy: null, aggregations: [{ fn: "sum", field: "amount" }] },
        CATALOGUE,
      ),
    ).toBe("SUM of Amount — Deals")
    expect(
      describeReport({ objectType: "deal", groupBy: null, aggregations: null }, CATALOGUE),
    ).toBe("All records — Deals")
  })

  test("describeReport degrades gracefully without a catalogue", () => {
    expect(describeReport({ objectType: "lead", groupBy: "source", aggregations: null })).toBe(
      "All records — lead by source",
    )
  })

  test("formatCell renders nulls and structured values safely", () => {
    expect(formatCell(null)).toBe("—")
    expect(formatCell(undefined)).toBe("—")
    expect(formatCell(0)).toBe("0")
    expect(formatCell(false)).toBe("false")
    expect(formatCell({ a: 1 })).toBe('{"a":1}')
  })
})
