import type { FilterCondition, FilterNode, FilterTree } from "@yourcrm/ui"

export type TicketListParams = {
  query?: string
  status?: string
  priority?: string
}

const STATUS_VALUES = new Set(["new", "open", "pending", "resolved", "closed"])
const PRIORITY_VALUES = new Set(["low", "normal", "high", "urgent"])

/**
 * Map a UI `FilterTree` onto the P0 list query params
 * (`?query=&status=&priority=`). Only AND-grouped `contains`/`eq` leaves on
 * `subject`, and `eq` leaves on `status`/`priority`, have server support
 * today; anything else is ignored so the builder stays usable for saved
 * views while structured search grows (mirrors `people/filters.ts`).
 */
export function treeToTicketParams(tree: FilterTree): TicketListParams {
  const params: TicketListParams = {}
  const visit = (node: FilterNode): void => {
    if (node.type === "group") {
      for (const child of node.children) visit(child)
      return
    }
    const leaf = node as FilterCondition
    if (typeof leaf.value !== "string" || leaf.value.trim() === "") return
    if (leaf.field === "status" && (leaf.operator === "eq" || leaf.operator === "in")) {
      const value = Array.isArray(leaf.value) ? leaf.value[0] : leaf.value
      if (typeof value === "string" && STATUS_VALUES.has(value)) params.status = value
      return
    }
    if (leaf.field === "priority" && (leaf.operator === "eq" || leaf.operator === "in")) {
      const value = Array.isArray(leaf.value) ? leaf.value[0] : leaf.value
      if (typeof value === "string" && PRIORITY_VALUES.has(value)) params.priority = value
      return
    }
    if (leaf.field === "subject" && (leaf.operator === "contains" || leaf.operator === "eq")) {
      params.query = params.query === undefined ? leaf.value : `${params.query} ${leaf.value}`
    }
  }
  visit(tree)
  return params
}
