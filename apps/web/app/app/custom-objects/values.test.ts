import { describe, expect, test } from "bun:test"
import { createFilterCondition, createFilterGroup, emptyFilterTree } from "@yourcrm/ui"
import type { FilterCondition, FilterOperator } from "@yourcrm/ui"
import { treeToCustomObjectParams } from "./filters"
import { formatCustomFieldValue, toFilterFields, type CustomObjectFieldDef } from "./types"
import {
  emptyFormState,
  missingRequiredFields,
  parseOptionList,
  toApiValues,
  toFormState,
} from "./values"

function def(overrides: Partial<CustomObjectFieldDef> & { key: string }): CustomObjectFieldDef {
  return {
    id: `field_${overrides.key}`,
    objectType: "deal-room",
    label: overrides.key,
    fieldType: "text",
    options: null,
    defaultValue: null,
    required: false,
    displayOrder: 0,
    ...overrides,
  }
}

const FIELDS: CustomObjectFieldDef[] = [
  def({ key: "title", label: "Title", fieldType: "text", required: true }),
  def({ key: "seats", label: "Seats", fieldType: "number" }),
  def({ key: "live", label: "Live", fieldType: "boolean" }),
  def({ key: "tier", label: "Tier", fieldType: "select", options: ["gold", "silver"] }),
  def({ key: "tags", label: "Tags", fieldType: "multiselect", options: ["a", "b"] }),
]

describe("custom-objects/form values", () => {
  test("empty state honours definition defaults", () => {
    const withDefaults = [
      def({ key: "tier", fieldType: "select", options: ["gold"], defaultValue: "gold" }),
      def({ key: "live", fieldType: "boolean", defaultValue: true }),
      def({ key: "tags", fieldType: "multiselect", defaultValue: ["a"] }),
      def({ key: "title" }),
    ]
    expect(emptyFormState(withDefaults)).toEqual({
      tier: "gold",
      live: true,
      tags: ["a"],
      title: "",
    })
  })

  test("stored values load into control-shaped state", () => {
    const state = toFormState(FIELDS, { title: "Acme", seats: 4, live: true, tags: ["a"] })
    expect(state).toEqual({ title: "Acme", seats: "4", live: true, tier: "", tags: ["a"] })
  })

  test("numbers are sent as numbers, blanks as null, checkboxes as booleans", () => {
    const values = toApiValues(FIELDS, {
      title: " Acme ",
      seats: "4",
      live: false,
      tier: "",
      tags: [],
    })
    expect(values).toEqual({ title: "Acme", seats: 4, live: false, tier: null, tags: null })
  })

  test("a non-numeric number stays a string so the server explains why", () => {
    const values = toApiValues(FIELDS, { title: "A", seats: "four", live: false, tags: [] })
    expect(values.seats).toBe("four")
  })

  test("required blanks are caught before the request", () => {
    expect(missingRequiredFields(FIELDS, emptyFormState(FIELDS))).toEqual(["Title"])
    const required = [def({ key: "tags", label: "Tags", fieldType: "multiselect", required: true })]
    expect(missingRequiredFields(required, { tags: [] })).toEqual(["Tags"])
  })

  test("option lists parse, trim and de-duplicate", () => {
    expect(parseOptionList(" gold , silver ,, gold ")).toEqual(["gold", "silver"])
    expect(parseOptionList("")).toEqual([])
  })
})

describe("custom-objects/display", () => {
  test("values render with their option labels and readable blanks", () => {
    const tier = def({
      key: "tier",
      fieldType: "select",
      options: [{ value: "gold", label: "Gold tier" }],
    })
    expect(formatCustomFieldValue(tier, "gold")).toBe("Gold tier")
    expect(formatCustomFieldValue(tier, null)).toBe("—")
    const live = def({ key: "live", fieldType: "boolean" })
    expect(formatCustomFieldValue(live, true)).toBe("Yes")
    const tags = def({ key: "tags", fieldType: "multiselect", options: ["a", "b"] })
    expect(formatCustomFieldValue(tags, ["a", "b"])).toBe("a, b")
  })

  test("filter definitions are derived from the object's own fields", () => {
    const filters = toFilterFields(FIELDS)
    expect(filters.map((field) => field.type)).toEqual([
      "text",
      "number",
      "boolean",
      "select",
      "select",
    ])
    expect(filters[3]?.options).toEqual([
      { value: "gold", label: "gold" },
      { value: "silver", label: "silver" },
    ])
  })
})

function leaf(field: string, operator: FilterOperator, value: unknown): FilterCondition {
  return { ...createFilterCondition(field, operator), value }
}

describe("custom-objects/filters", () => {
  test("an eq leaf becomes the exact field filter", () => {
    const tree = emptyFilterTree()
    tree.children.push(leaf("tier", "eq", "gold"))
    expect(treeToCustomObjectParams(tree, FIELDS)).toEqual({ field: "tier", value: "gold" })
  })

  test("a contains leaf becomes the display-name search", () => {
    const tree = emptyFilterTree()
    tree.children.push(leaf("title", "contains", " acme "))
    expect(treeToCustomObjectParams(tree, FIELDS)).toEqual({ query: "acme" })
  })

  test("nested groups are visited too", () => {
    const tree = emptyFilterTree()
    const group = createFilterGroup("or")
    group.children.push(leaf("tier", "eq", "silver"))
    tree.children.push(group)
    expect(treeToCustomObjectParams(tree, FIELDS)).toEqual({ field: "tier", value: "silver" })
  })

  test("unknown fields and unsupported operators are dropped, not faked", () => {
    const tree = emptyFilterTree()
    tree.children.push(leaf("ghost", "eq", "x"))
    tree.children.push(leaf("seats", "gt", 3))
    tree.children.push(leaf("title", "contains", "   "))
    expect(treeToCustomObjectParams(tree, FIELDS)).toEqual({})
  })
})
