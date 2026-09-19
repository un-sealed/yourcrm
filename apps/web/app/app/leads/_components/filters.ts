import type { FilterCondition, FilterNode, FilterTree } from "@yourcrm/ui"
import { LEAD_SOURCES, LEAD_STATUSES } from "./types"

export type LeadsListParams = {
  query?: string
  status?: string
  source?: string
}

/**
 * Map a UI `FilterTree` onto the P0 list query params
 * (`?query=&status=&source=`). Only AND-grouped `contains` leaves on
 * name/company fields and `eq` leaves on `status`/`source` have server
 * support today; anything else is ignored so the builder stays usable for
 * saved views while structured search grows.
 */
export function treeToLeadsParams(tree: FilterTree): LeadsListParams {
  const params: LeadsListParams = {}
  const visit = (node: FilterNode): void => {
    if (node.type === "group") {
      for (const child of node.children) visit(child)
      return
    }
    const leaf = node as FilterCondition
    if (typeof leaf.value !== "string" || leaf.value.trim() === "") return
    if (leaf.field === "status" && (leaf.operator === "eq" || leaf.operator === "in")) {
      const value = Array.isArray(leaf.value) ? leaf.value[0] : leaf.value
      if ((LEAD_STATUSES as readonly string[]).includes(value)) params.status = value
      return
    }
    if (leaf.field === "source" && (leaf.operator === "eq" || leaf.operator === "in")) {
      const value = Array.isArray(leaf.value) ? leaf.value[0] : leaf.value
      if ((LEAD_SOURCES as readonly string[]).includes(value)) params.source = value
      return
    }
    if (
      (leaf.field === "firstName" || leaf.field === "lastName" || leaf.field === "companyName") &&
      (leaf.operator === "contains" || leaf.operator === "eq")
    ) {
      params.query = params.query === undefined ? leaf.value : `${params.query} ${leaf.value}`
    }
  }
  visit(tree)
  return params
}
