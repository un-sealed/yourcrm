import * as React from "react"
import { Button } from "./button"
import { Checkbox } from "./checkbox"
import { useControlledState } from "./controlled"
import { EmptyState } from "./empty-state"
import { Skeleton } from "./skeleton"
import { cn } from "./utils"

/* --------------------------------- types --------------------------------- */

export type DataTableSortDirection = "asc" | "desc"

export interface DataTableSort {
  columnId: string
  direction: DataTableSortDirection
}

export interface DataTableEditingCell {
  rowId: string
  columnId: string
}

export interface DataTableColumn<T> {
  id: string
  header: React.ReactNode
  accessor: (row: T) => React.ReactNode
  sortable?: boolean
  align?: "left" | "center" | "right"
  width?: string
  renderEdit?: (args: {
    row: T
    onCommit: (patch: Partial<T>) => void
    onCancel: () => void
  }) => React.ReactNode
}

/** Cursor pagination: `cursor` in (current position), `nextCursor` out. */
export interface DataTablePagination {
  cursor: string | null
  nextCursor: string | null
  limit: number
}

export interface DataTableProps<T> {
  rows: T[]
  columns: DataTableColumn<T>[]
  getRowId: (row: T) => string
  sort?: DataTableSort | null
  onSortChange?: (sort: DataTableSort | null) => void
  columnOrder?: string[]
  onColumnOrderChange?: (order: string[]) => void
  hiddenColumns?: string[]
  onHiddenColumnsChange?: (hidden: string[]) => void
  selectedIds?: string[]
  onSelectionChange?: (ids: string[]) => void
  selectable?: boolean
  loading?: boolean
  skeletonRowCount?: number
  empty?: React.ReactNode
  pagination?: DataTablePagination
  onPageChange?: (cursor: string | null) => void
  editingCell?: DataTableEditingCell | null
  onEditingCellChange?: (cell: DataTableEditingCell | null) => void
  onRowCommit?: (rowId: string, patch: Partial<T>) => void
  ariaLabel?: string
  className?: string
  ref?: React.Ref<HTMLDivElement>
}

/* -------------------------------- helpers -------------------------------- */

export type SelectionState = "none" | "some" | "all"

/** Header-checkbox state derived from visible row ids and the selection. */
export function getSelectionState(rowIds: string[], selectedIds: string[]): SelectionState {
  if (rowIds.length === 0) {
    return "none"
  }
  const count = rowIds.filter((id) => selectedIds.includes(id)).length
  if (count === 0) {
    return "none"
  }
  return count === rowIds.length ? "all" : "some"
}

export function toggleRowSelected(selectedIds: string[], rowId: string): string[] {
  return selectedIds.includes(rowId)
    ? selectedIds.filter((id) => id !== rowId)
    : [...selectedIds, rowId]
}

/** Header checkbox toggle: select all visible rows, or clear when all selected. */
export function toggleAllSelected(selectedIds: string[], visibleIds: string[]): string[] {
  return getSelectionState(visibleIds, selectedIds) === "all" ? [] : [...visibleIds]
}

/** Sort cycling for a header click: none -> asc -> desc -> none. */
export function nextSortDirection(
  current: DataTableSort | null,
  columnId: string,
): DataTableSort | null {
  if (current === null || current === undefined || current.columnId !== columnId) {
    return { columnId, direction: "asc" }
  }
  if (current.direction === "asc") {
    return { columnId, direction: "desc" }
  }
  return null
}

/** Move a column id by `delta` (-1 left, +1 right); out-of-bounds is a no-op. */
export function moveColumnId(order: string[], columnId: string, delta: -1 | 1): string[] {
  const from = order.indexOf(columnId)
  const to = from + delta
  if (from < 0 || to < 0 || to >= order.length) {
    return [...order]
  }
  const next = [...order]
  const moving = next[from] as string
  next[from] = next[to] as string
  next[to] = moving
  return next
}

export function toggleHiddenColumn(hidden: string[], columnId: string): string[] {
  return hidden.includes(columnId) ? hidden.filter((id) => id !== columnId) : [...hidden, columnId]
}

/** Apply `order` then `hidden` to the column defs (unknown ids ignored). */
export function resolveDataTableColumns<T>(
  columns: DataTableColumn<T>[],
  order: string[],
  hidden: string[],
): DataTableColumn<T>[] {
  const byId = new Map(columns.map((column) => [column.id, column]))
  const visible: DataTableColumn<T>[] = []
  for (const id of order) {
    const column = byId.get(id)
    if (column !== undefined && !hidden.includes(id)) {
      visible.push(column)
    }
  }
  for (const column of columns) {
    if (!order.includes(column.id) && !hidden.includes(column.id)) {
      visible.push(column)
    }
  }
  return visible
}

/* --------------------------------- table --------------------------------- */

const ALIGN_CLASSES = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
} as const

/**
 * Generic CRM data table. Controlled (selection, sort, order, visibility,
 * pagination, editing) with uncontrolled fallbacks, so `rows` + `columns` +
 * `getRowId` alone render a working table. Loading renders `Skeleton` rows
 * preserving the column layout; empty renders `EmptyState`.
 */
export function DataTable<T>({
  rows,
  columns,
  getRowId,
  sort: sortProp,
  onSortChange,
  columnOrder: orderProp,
  onColumnOrderChange,
  hiddenColumns: hiddenProp,
  onHiddenColumnsChange,
  selectedIds: selectedProp,
  onSelectionChange,
  selectable = false,
  loading = false,
  skeletonRowCount = 5,
  empty,
  pagination,
  onPageChange,
  editingCell: editingProp,
  onEditingCellChange,
  onRowCommit,
  ariaLabel = "Data table",
  className,
  ref,
}: DataTableProps<T>): React.ReactElement {
  const [sort, setSort] = useControlledState<DataTableSort | null>(sortProp, null, onSortChange)
  const [order, setOrder] = useControlledState<string[]>(
    orderProp,
    columns.map((column) => column.id),
    onColumnOrderChange,
  )
  const [hidden, setHidden] = useControlledState<string[]>(hiddenProp, [], onHiddenColumnsChange)
  const [selected, setSelected] = useControlledState<string[]>(selectedProp, [], onSelectionChange)
  const [editing, setEditing] = useControlledState<DataTableEditingCell | null>(
    editingProp,
    null,
    onEditingCellChange,
  )
  const tableRef = React.useRef<HTMLTableElement | null>(null)

  const visibleColumns = React.useMemo(
    () => resolveDataTableColumns(columns, order, hidden),
    [columns, order, hidden],
  )
  const rowIds = React.useMemo(() => rows.map((row) => getRowId(row)), [rows, getRowId])
  const selectionState = getSelectionState(rowIds, selected)

  const moveFocus = (event: React.KeyboardEvent, row: number, col: number): void => {
    let nextRow = row
    let nextCol = col
    if (event.key === "ArrowDown") {
      nextRow += 1
    } else if (event.key === "ArrowUp") {
      nextRow -= 1
    } else if (event.key === "ArrowRight") {
      nextCol += 1
    } else if (event.key === "ArrowLeft") {
      nextCol -= 1
    } else {
      return
    }
    event.preventDefault()
    tableRef.current?.querySelector<HTMLElement>(`[data-cell="${nextRow}-${nextCol}"]`)?.focus()
  }

  const selectionColumnWidth = selectable ? 1 : 0
  const totalColumns = visibleColumns.length + selectionColumnWidth

  return (
    <div ref={ref} data-slot="data-table" className={cn("flex flex-col gap-2", className)}>
      <details className="self-end text-xs">
        <summary className="cursor-pointer rounded px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Columns
        </summary>
        <div className="absolute z-50 mt-1 flex flex-col gap-1 rounded-md border border-border bg-background p-2 shadow-md">
          {columns.map((column) => {
            const position = order.includes(column.id) ? order.indexOf(column.id) : order.length
            return (
              <div key={column.id} className="flex items-center gap-1">
                <label className="flex flex-1 cursor-pointer items-center gap-1.5 whitespace-nowrap text-foreground">
                  <Checkbox
                    checked={!hidden.includes(column.id)}
                    aria-label={`Show column ${column.id}`}
                    onChange={() => setHidden(toggleHiddenColumn(hidden, column.id))}
                  />
                  <span className="text-xs">{column.id}</span>
                </label>
                <button
                  type="button"
                  aria-label={`Move column ${column.id} left`}
                  disabled={position <= 0}
                  onClick={() => setOrder(moveColumnId(order, column.id, -1))}
                  className="rounded px-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                >
                  ◀
                </button>
                <button
                  type="button"
                  aria-label={`Move column ${column.id} right`}
                  disabled={position < 0 || position >= order.length - 1}
                  onClick={() => setOrder(moveColumnId(order, column.id, 1))}
                  className="rounded px-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                >
                  ▶
                </button>
              </div>
            )
          })}
        </div>
      </details>

      <div className="overflow-x-auto rounded-md border border-border">
        <table ref={tableRef} aria-label={ariaLabel} className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              {selectable ? (
                <th scope="col" className="w-10 px-2 py-2">
                  <Checkbox
                    checked={selectionState === "all"}
                    indeterminate={selectionState === "some"}
                    aria-label="Select all rows"
                    onChange={() => setSelected(toggleAllSelected(selected, rowIds))}
                  />
                </th>
              ) : null}
              {visibleColumns.map((column) => {
                const active = sort?.columnId === column.id ? sort : null
                return (
                  <th
                    key={column.id}
                    scope="col"
                    style={column.width !== undefined ? { width: column.width } : undefined}
                    aria-sort={
                      active !== null
                        ? active.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                    className={cn(
                      "px-3 py-2 font-medium text-muted-foreground",
                      ALIGN_CLASSES[column.align ?? "left"],
                    )}
                  >
                    {column.sortable === true ? (
                      <button
                        type="button"
                        aria-label={`Sort by ${column.id}`}
                        onClick={() => setSort(nextSortDirection(sort, column.id))}
                        className="inline-flex items-center gap-1 rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {column.header}
                        <span aria-hidden="true">
                          {active === null ? "↕" : active.direction === "asc" ? "▲" : "▼"}
                        </span>
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: skeletonRowCount }, (_, index) => (
                  <tr key={`skeleton-${index}`} className="border-b border-border last:border-0">
                    {selectable ? (
                      <td className="px-2 py-2">
                        <Skeleton className="h-4 w-4" />
                      </td>
                    ) : null}
                    {visibleColumns.map((column) => (
                      <td key={column.id} className="px-3 py-2">
                        <Skeleton className="h-4 w-full" />
                      </td>
                    ))}
                  </tr>
                ))
              : rows.map((row, rowIndex) => {
                  const rowId = getRowId(row)
                  const checked = selected.includes(rowId)
                  return (
                    <tr
                      key={rowId}
                      data-row-id={rowId}
                      aria-selected={selectable ? checked : undefined}
                      className={cn(
                        "border-b border-border last:border-0 hover:bg-muted/40",
                        checked && "bg-muted/60",
                      )}
                    >
                      {selectable ? (
                        <td className="px-2 py-2">
                          <Checkbox
                            checked={checked}
                            aria-label={`Select row ${rowId}`}
                            onChange={() => setSelected(toggleRowSelected(selected, rowId))}
                          />
                        </td>
                      ) : null}
                      {visibleColumns.map((column, colIndex) => {
                        const isEditing =
                          editing !== null &&
                          editing.rowId === rowId &&
                          editing.columnId === column.id
                        return (
                          <td
                            key={column.id}
                            tabIndex={0}
                            data-cell={`${rowIndex}-${colIndex}`}
                            onKeyDown={(event) => {
                              if (
                                event.key === "Enter" &&
                                event.target === event.currentTarget &&
                                column.renderEdit !== undefined &&
                                !isEditing
                              ) {
                                event.preventDefault()
                                setEditing({ rowId, columnId: column.id })
                              } else if (event.key === "Escape" && isEditing) {
                                setEditing(null)
                              } else {
                                moveFocus(event, rowIndex, colIndex)
                              }
                            }}
                            onDoubleClick={() => {
                              if (column.renderEdit !== undefined) {
                                setEditing({ rowId, columnId: column.id })
                              }
                            }}
                            className={cn(
                              "px-3 py-2 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                              ALIGN_CLASSES[column.align ?? "left"],
                            )}
                          >
                            {isEditing && column.renderEdit !== undefined
                              ? column.renderEdit({
                                  row,
                                  onCommit: (patch) => {
                                    onRowCommit?.(rowId, patch)
                                    setEditing(null)
                                  },
                                  onCancel: () => setEditing(null),
                                })
                              : column.accessor(row)}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
            {!loading && rows.length === 0 ? (
              <tr>
                <td colSpan={totalColumns} className="px-3 py-2">
                  {empty ?? (
                    <EmptyState
                      title="No results"
                      description="Try adjusting your search or filters."
                    />
                  )}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {pagination !== undefined ? (
        <nav aria-label="Table pagination" className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{pagination.limit} per page</span>
          <span className="flex items-center gap-1">
            {pagination.cursor !== null ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => onPageChange?.(null)}
              >
                First page
              </Button>
            ) : null}
            {pagination.nextCursor !== null ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => onPageChange?.(pagination.nextCursor)}
              >
                Next
              </Button>
            ) : null}
          </span>
        </nav>
      ) : null}
    </div>
  )
}
