import { describe, expect, test } from "bun:test"
import * as React from "react"
import {
  DataTable,
  getSelectionState,
  moveColumnId,
  nextSortDirection,
  resolveDataTableColumns,
  toggleAllSelected,
  toggleHiddenColumn,
  toggleRowSelected,
  type DataTableColumn,
} from "./data-table"

interface Contact {
  id: string
  name: string
}

const COLUMNS: DataTableColumn<Contact>[] = [
  { id: "name", header: "Name", accessor: (row) => row.name, sortable: true },
  { id: "id", header: "ID", accessor: (row) => row.id },
]

describe("ui/data-table selection helpers", () => {
  test("getSelectionState distinguishes none/some/all", () => {
    expect(getSelectionState(["a", "b"], [])).toBe("none")
    expect(getSelectionState([], [])).toBe("none")
    expect(getSelectionState(["a", "b"], ["a"])).toBe("some")
    expect(getSelectionState(["a", "b"], ["a", "b"])).toBe("all")
  })

  test("toggleRowSelected adds and removes ids", () => {
    expect(toggleRowSelected([], "a")).toEqual(["a"])
    expect(toggleRowSelected(["a", "b"], "a")).toEqual(["b"])
  })

  test("toggleAllSelected selects all or clears", () => {
    expect(toggleAllSelected([], ["a", "b"])).toEqual(["a", "b"])
    expect(toggleAllSelected(["a"], ["a", "b"])).toEqual(["a", "b"])
    expect(toggleAllSelected(["a", "b"], ["a", "b"])).toEqual([])
  })
})

describe("ui/data-table sort helper", () => {
  test("cycles none -> asc -> desc -> none per column", () => {
    expect(nextSortDirection(null, "name")).toEqual({ columnId: "name", direction: "asc" })
    expect(nextSortDirection({ columnId: "name", direction: "asc" }, "name")).toEqual({
      columnId: "name",
      direction: "desc",
    })
    expect(nextSortDirection({ columnId: "name", direction: "desc" }, "name")).toBe(null)
    expect(nextSortDirection({ columnId: "name", direction: "desc" }, "id")).toEqual({
      columnId: "id",
      direction: "asc",
    })
  })
})

describe("ui/data-table column helpers", () => {
  test("moveColumnId reorders within bounds and ignores the rest", () => {
    expect(moveColumnId(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"])
    expect(moveColumnId(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"])
    expect(moveColumnId(["a", "b"], "a", -1)).toEqual(["a", "b"])
    expect(moveColumnId(["a", "b"], "b", 1)).toEqual(["a", "b"])
    expect(moveColumnId(["a", "b"], "zzz", 1)).toEqual(["a", "b"])
  })

  test("toggleHiddenColumn flips visibility", () => {
    expect(toggleHiddenColumn([], "a")).toEqual(["a"])
    expect(toggleHiddenColumn(["a"], "a")).toEqual([])
  })

  test("resolveDataTableColumns applies order then visibility", () => {
    expect(resolveDataTableColumns(COLUMNS, ["id", "name"], []).map((column) => column.id)).toEqual(
      ["id", "name"],
    )
    expect(
      resolveDataTableColumns(COLUMNS, ["id", "name"], ["name"]).map((column) => column.id),
    ).toEqual(["id"])
    expect(resolveDataTableColumns(COLUMNS, ["unknown"], []).map((column) => column.id)).toEqual([
      "name",
      "id",
    ])
  })
})

describe("ui/DataTable", () => {
  test("is usable without a wrapper (uncontrolled fallbacks)", () => {
    const element = (
      <DataTable<Contact>
        rows={[{ id: "1", name: "Ada" }]}
        columns={COLUMNS}
        getRowId={(row) => row.id}
      />
    )
    expect(React.isValidElement(element)).toBe(true)
  })

  test("accepts the full controlled contract", () => {
    const noop = (): void => undefined
    const element = (
      <DataTable<Contact>
        rows={[]}
        columns={COLUMNS}
        getRowId={(row) => row.id}
        sort={null}
        onSortChange={noop}
        columnOrder={["name", "id"]}
        onColumnOrderChange={noop}
        hiddenColumns={[]}
        onHiddenColumnsChange={noop}
        selectedIds={[]}
        onSelectionChange={noop}
        selectable={true}
        loading={false}
        pagination={{ cursor: null, nextCursor: "abc", limit: 20 }}
        onPageChange={noop}
        editingCell={null}
        onEditingCellChange={noop}
        onRowCommit={noop}
        ariaLabel="Contacts"
      />
    )
    expect(React.isValidElement(element)).toBe(true)
    expect(element.props.selectable).toBe(true)
    expect(element.props.pagination).toEqual({ cursor: null, nextCursor: "abc", limit: 20 })
  })
})
