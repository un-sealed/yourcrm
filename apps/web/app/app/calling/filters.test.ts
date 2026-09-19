import { describe, expect, test } from "bun:test"
import { emptyFilterTree, type FilterTree } from "@yourcrm/ui"
import { treeToCallingParams } from "./filters"

function treeWith(children: FilterTree["children"]): FilterTree {
  return { ...emptyFilterTree("root"), children }
}

describe("calling/filters", () => {
  test("empty tree maps to no params", () => {
    expect(treeToCallingParams(emptyFilterTree())).toEqual({})
  })

  test("direction eq maps to the direction param", () => {
    const tree = treeWith([
      { type: "condition", id: "c1", field: "direction", operator: "eq", value: "inbound" },
    ])
    expect(treeToCallingParams(tree)).toEqual({ direction: "inbound" })
  })

  test("an unknown direction value is ignored", () => {
    const tree = treeWith([
      { type: "condition", id: "c1", field: "direction", operator: "eq", value: "sideways" },
    ])
    expect(treeToCallingParams(tree)).toEqual({})
  })

  test("status eq maps to the status param", () => {
    const tree = treeWith([
      { type: "condition", id: "c1", field: "status", operator: "eq", value: "completed" },
    ])
    expect(treeToCallingParams(tree)).toEqual({ status: "completed" })
  })

  test("disposition contains maps to the search query", () => {
    const tree = treeWith([
      {
        type: "condition",
        id: "c1",
        field: "disposition",
        operator: "contains",
        value: "interested",
      },
    ])
    expect(treeToCallingParams(tree)).toEqual({ query: "interested" })
  })

  test("blank and unsupported leaves are ignored", () => {
    const tree = treeWith([
      { type: "condition", id: "c1", field: "disposition", operator: "contains", value: "  " },
      { type: "condition", id: "c2", field: "notes", operator: "eq", value: "vip" },
    ])
    expect(treeToCallingParams(tree)).toEqual({})
  })

  test("groups are visited recursively", () => {
    const tree: FilterTree = {
      ...emptyFilterTree("root"),
      children: [
        {
          type: "group",
          id: "g1",
          combinator: "and",
          children: [
            { type: "condition", id: "c1", field: "status", operator: "eq", value: "failed" },
          ],
        },
      ],
    }
    expect(treeToCallingParams(tree)).toEqual({ status: "failed" })
  })
})
