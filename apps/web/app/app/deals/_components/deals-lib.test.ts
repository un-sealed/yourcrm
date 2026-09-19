import { describe, expect, test } from "bun:test"
import { emptyFilterTree, type FilterTree } from "@yourcrm/ui"
import { treeToDealsParams, weightedValue } from "./deals-lib"

function treeWith(children: FilterTree["children"]): FilterTree {
  return { ...emptyFilterTree("root"), children }
}

describe("deals/filters", () => {
  test("empty tree maps to no params", () => {
    expect(treeToDealsParams(emptyFilterTree())).toEqual({})
  })

  test("stage eq maps to the stage param", () => {
    const tree = treeWith([
      { type: "condition", id: "c1", field: "stage", operator: "eq", value: "proposal" },
    ])
    expect(treeToDealsParams(tree)).toEqual({ stage: "proposal" })
  })

  test("name contains maps to the search query", () => {
    const tree = treeWith([
      { type: "condition", id: "c1", field: "name", operator: "contains", value: "acme" },
    ])
    expect(treeToDealsParams(tree)).toEqual({ query: "acme" })
  })

  test("blank and unsupported leaves are ignored", () => {
    const tree = treeWith([
      { type: "condition", id: "c1", field: "name", operator: "contains", value: "  " },
      { type: "condition", id: "c2", field: "stage", operator: "eq", value: "vip" },
    ])
    expect(treeToDealsParams(tree)).toEqual({})
  })
})

describe("deals/weightedValue", () => {
  test("amount times probability over 100", () => {
    expect(weightedValue({ amount: "50000.00", probability: 50 })).toBe(25000)
    expect(weightedValue({ amount: 10000, probability: 25 })).toBe(2500)
  })

  test("null when either side is missing", () => {
    expect(weightedValue({ amount: null, probability: 50 })).toBeNull()
    expect(weightedValue({ amount: 10000, probability: null })).toBeNull()
  })
})
