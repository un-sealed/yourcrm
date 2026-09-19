import { describe, expect, test } from "bun:test"
import {
  FilterBuilder,
  addFilterNode,
  createFilterCondition,
  createFilterGroup,
  decodeFilterTree,
  emptyFilterTree,
  encodeFilterTree,
  operatorsForFieldType,
  removeFilterNode,
  setGroupCombinator,
  updateFilterNode,
  type FilterFieldDef,
  type FilterTree,
} from "./filter-builder"
import { expand, findAll, only, textOf } from "./test-helpers"

const FIELDS: FilterFieldDef[] = [
  { name: "name", label: "Name", type: "text" },
  { name: "value", label: "Value", type: "number" },
  { name: "stage", label: "Stage", type: "select", options: [{ value: "new", label: "New" }] },
]

describe("ui/filter-tree helpers", () => {
  test("operators follow the field type", () => {
    expect(operatorsForFieldType("text")).toContain("contains")
    expect(operatorsForFieldType("text")).not.toContain("between")
    expect(operatorsForFieldType("number")).toContain("between")
    expect(operatorsForFieldType("boolean")).toEqual(["eq", "neq"])
  })

  test("add/update/remove round-trips through groups", () => {
    let tree = emptyFilterTree("root")
    tree = addFilterNode(tree, "root", createFilterCondition("name", "contains", "c1"))
    tree = addFilterNode(tree, "root", createFilterGroup("or", "g1"))
    tree = addFilterNode(tree, "g1", createFilterCondition("value", "gt", "c2"))
    expect(tree.children.length).toBe(2)
    tree = setGroupCombinator(tree, "g1", "and")
    const group = tree.children[1]
    expect(group?.type === "group" ? group.combinator : null).toBe("and")
    tree = updateFilterNode(tree, "c1", (node) =>
      node.type === "condition" ? { ...node, value: "acme" } : node,
    )
    const condition = tree.children[0]
    expect(condition?.type === "condition" ? condition.value : null).toBe("acme")
    tree = removeFilterNode(tree, "c2")
    const pruned = tree.children[1]
    expect(pruned?.type === "group" ? pruned.children.length : -1).toBe(0)
    tree = removeFilterNode(tree, "root")
    expect(tree.id).toBe("root")
  })

  test("encode/decode round-trips and rejects garbage", () => {
    const tree: FilterTree = {
      type: "group",
      id: "root",
      combinator: "and",
      children: [
        { type: "condition", id: "c1", field: "name", operator: "contains", value: "acmé ✓" },
      ],
    }
    const encoded = encodeFilterTree(tree)
    expect(typeof encoded).toBe("string")
    expect(encoded).not.toContain("?")
    expect(decodeFilterTree(encoded)).toEqual(tree)
    expect(() => decodeFilterTree("!!!not-base64!!!")).toThrow()
    expect(() =>
      decodeFilterTree(encodeFilterTree({ ...tree, combinator: "xor" } as unknown as FilterTree)),
    ).toThrow()
  })
})

describe("ui/FilterBuilder", () => {
  test("renders groups, conditions and the empty hint", () => {
    const tree: FilterTree = {
      type: "group",
      id: "root",
      combinator: "and",
      children: [
        { type: "condition", id: "c1", field: "name", operator: "contains", value: "acme" },
        {
          type: "group",
          id: "g1",
          combinator: "or",
          children: [{ type: "condition", id: "c2", field: "value", operator: "gt", value: "10" }],
        },
      ],
    }
    const node = only(
      expand(<FilterBuilder value={tree} onChange={() => undefined} fields={FIELDS} />),
    )
    expect(textOf(node)).not.toContain("No conditions")
    const conditions = findAll(
      [node],
      (candidate) => candidate.props["data-slot"] === "filter-condition",
    )
    expect(conditions.length).toBe(2)
    const groups = findAll([node], (candidate) => candidate.props["data-slot"] === "filter-group")
    expect(groups.length).toBe(2)
  })

  test("primary interaction: combinator toggle and add-condition emit new trees", () => {
    const seen: FilterTree[] = []
    const tree = emptyFilterTree("root")
    const node = only(
      expand(
        <FilterBuilder
          value={tree}
          onChange={(next) => {
            seen.push(next)
          }}
          fields={FIELDS}
        />,
      ),
    )
    const buttons = findAll([node], (candidate) => candidate.type === "button")
    const orButton = buttons.find((button) => textOf(button) === "or")
    ;(orButton?.props["onClick"] as () => void)()
    expect(seen[0]?.combinator).toBe("or")

    const addButton = buttons.find((button) => textOf(button) === "+ Condition")
    ;(addButton?.props["onClick"] as () => void)()
    const added = seen[1] as FilterTree | undefined
    expect(added?.children.length).toBe(1)
    const first = added?.children[0]
    expect(first?.type === "condition" ? first.field : null).toBe("name")
  })
})
