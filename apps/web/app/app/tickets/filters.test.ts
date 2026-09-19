import { describe, expect, test } from "bun:test"
import { emptyFilterTree, type FilterTree } from "@yourcrm/ui"
import { treeToTicketParams } from "./filters"

function treeWith(children: FilterTree["children"]): FilterTree {
  return { ...emptyFilterTree("root"), children }
}

describe("tickets/filters", () => {
  test("empty tree maps to no params", () => {
    expect(treeToTicketParams(emptyFilterTree())).toEqual({})
  })

  test("status eq maps to the status param", () => {
    const tree = treeWith([
      { type: "condition", id: "c1", field: "status", operator: "eq", value: "resolved" },
    ])
    expect(treeToTicketParams(tree)).toEqual({ status: "resolved" })
  })

  test("an unknown status value is ignored", () => {
    const tree = treeWith([
      { type: "condition", id: "c1", field: "status", operator: "eq", value: "archived" },
    ])
    expect(treeToTicketParams(tree)).toEqual({})
  })

  test("priority eq maps to the priority param", () => {
    const tree = treeWith([
      { type: "condition", id: "c1", field: "priority", operator: "eq", value: "urgent" },
    ])
    expect(treeToTicketParams(tree)).toEqual({ priority: "urgent" })
  })

  test("subject contains maps to the search query", () => {
    const tree = treeWith([
      { type: "condition", id: "c1", field: "subject", operator: "contains", value: "login" },
    ])
    expect(treeToTicketParams(tree)).toEqual({ query: "login" })
  })

  test("blank and unsupported leaves are ignored", () => {
    const tree = treeWith([
      { type: "condition", id: "c1", field: "subject", operator: "contains", value: "  " },
      { type: "condition", id: "c2", field: "assigneeId", operator: "eq", value: "user_1" },
    ])
    expect(treeToTicketParams(tree)).toEqual({})
  })
})
