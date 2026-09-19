import { describe, expect, test } from "bun:test"
import { emptyFilterTree, type FilterTree } from "@yourcrm/ui"
import { treeToQuoteParams } from "./filters"

function treeWith(children: FilterTree["children"]): FilterTree {
  return { ...emptyFilterTree("root"), children }
}

describe("quotes/filters", () => {
  test("empty tree maps to no params", () => {
    expect(treeToQuoteParams(emptyFilterTree())).toEqual({})
  })

  test("status eq maps to the status param", () => {
    const tree = treeWith([
      { type: "condition", id: "c1", field: "status", operator: "eq", value: "accepted" },
    ])
    expect(treeToQuoteParams(tree)).toEqual({ status: "accepted" })
  })

  test("number contains maps to the search query", () => {
    const tree = treeWith([
      { type: "condition", id: "c1", field: "number", operator: "contains", value: "Q-001" },
    ])
    expect(treeToQuoteParams(tree)).toEqual({ query: "Q-001" })
  })

  test("blank and unsupported leaves are ignored", () => {
    const tree = treeWith([
      { type: "condition", id: "c1", field: "number", operator: "contains", value: "  " },
      { type: "condition", id: "c2", field: "status", operator: "eq", value: "cancelled" },
    ])
    expect(treeToQuoteParams(tree)).toEqual({})
  })
})
