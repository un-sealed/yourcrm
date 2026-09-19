import type { FilterCondition, FilterNode, FilterTree } from "@yourcrm/ui"

export type ActivitiesListParams = {
  query?: string
  type?: string
  status?: string
}

/**
 * Map a UI `FilterTree` onto the P0 list query params
 * (`?query=&type=&status=`). Only `contains` leaves on the title field and
 * `eq` leaves on `type`/`status` have server support today; anything else is
 * ignored so the builder stays usable for saved views while structured
 * search grows.
 */
export function treeToActivitiesParams(tree: FilterTree): ActivitiesListParams {
  const params: ActivitiesListParams = {}
  const visit = (node: FilterNode): void => {
    if (node.type === "group") {
      for (const child of node.children) visit(child)
      return
    }
    const leaf = node as FilterCondition
    if (typeof leaf.value !== "string" || leaf.value.trim() === "") return
    if (leaf.field === "type" && (leaf.operator === "eq" || leaf.operator === "in")) {
      const value = Array.isArray(leaf.value) ? leaf.value[0] : leaf.value
      if (value === "note" || value === "call" || value === "meeting" || value === "email") {
        params.type = value
      }
      return
    }
    if (leaf.field === "status" && (leaf.operator === "eq" || leaf.operator === "in")) {
      const value = Array.isArray(leaf.value) ? leaf.value[0] : leaf.value
      if (value === "open" || value === "completed" || value === "cancelled") {
        params.status = value
      }
      return
    }
    if (leaf.field === "title" && (leaf.operator === "contains" || leaf.operator === "eq")) {
      params.query = params.query === undefined ? leaf.value : `${params.query} ${leaf.value}`
    }
  }
  visit(tree)
  return params
}
