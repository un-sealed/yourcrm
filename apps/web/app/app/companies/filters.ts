import type { FilterCondition, FilterNode, FilterTree } from "@yourcrm/ui"

export type CompaniesListParams = {
  query?: string
  status?: string
  industry?: string
}

/**
 * Map a UI `FilterTree` onto the P0 list query params
 * (`?query=&status=&industry=`). Only AND-grouped `contains` leaves on
 * name/domain/industry fields and `eq` leaves on `status` have server support
 * today; anything else is ignored so the builder stays usable for saved views
 * while structured search grows.
 */
export function treeToCompaniesParams(tree: FilterTree): CompaniesListParams {
  const params: CompaniesListParams = {}
  const visit = (node: FilterNode): void => {
    if (node.type === "group") {
      for (const child of node.children) visit(child)
      return
    }
    const leaf = node as FilterCondition
    if (typeof leaf.value !== "string" || leaf.value.trim() === "") return
    if (leaf.field === "status" && (leaf.operator === "eq" || leaf.operator === "in")) {
      const value = Array.isArray(leaf.value) ? leaf.value[0] : leaf.value
      if (value === "active" || value === "archived") params.status = value
      return
    }
    if (leaf.field === "industry" && (leaf.operator === "eq" || leaf.operator === "in")) {
      const value = Array.isArray(leaf.value) ? leaf.value[0] : leaf.value
      if (typeof value === "string" && value.trim() !== "") params.industry = value.trim()
      return
    }
    if (
      (leaf.field === "name" || leaf.field === "domain" || leaf.field === "industry") &&
      (leaf.operator === "contains" || leaf.operator === "eq")
    ) {
      params.query = params.query === undefined ? leaf.value : `${params.query} ${leaf.value}`
    }
  }
  visit(tree)
  return params
}
