import { describe, expect, test } from "bun:test"
import { emptyFilterTree, type FilterTree } from "@yourcrm/ui"
import { treeToPeopleParams } from "./filters"

function treeWith(children: FilterTree["children"]): FilterTree {
  return { ...emptyFilterTree("root"), children }
}

describe("people/filters", () => {
  test("empty tree maps to no params", () => {
    expect(treeToPeopleParams(emptyFilterTree())).toEqual({})
  })

  test("status eq maps to the status param", () => {
    const tree = treeWith([
      { type: "condition", id: "c1", field: "status", operator: "eq", value: "archived" },
    ])
    expect(treeToPeopleParams(tree)).toEqual({ status: "archived" })
  })

  test("name contains maps to the search query", () => {
    const tree = treeWith([
      { type: "condition", id: "c1", field: "firstName", operator: "contains", value: "ada" },
    ])
    expect(treeToPeopleParams(tree)).toEqual({ query: "ada" })
  })

  test("blank and unsupported leaves are ignored", () => {
    const tree = treeWith([
      { type: "condition", id: "c1", field: "firstName", operator: "contains", value: "  " },
      { type: "condition", id: "c2", field: "status", operator: "eq", value: "vip" },
    ])
    expect(treeToPeopleParams(tree)).toEqual({})
  })
})
