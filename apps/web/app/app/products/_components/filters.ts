import type { FilterCondition, FilterNode, FilterTree } from "@yourcrm/ui"

export type ProductsListParams = {
  query?: string
  active?: string
}

/**
 * Map a UI `FilterTree` onto the P0 list query params (`?query=&active=`).
 * Only `contains` leaves on sku/name and `eq` leaves on `isActive` have
 * server support today; anything else is ignored so the builder stays usable
 * for saved views while structured search grows.
 */
export function treeToProductsParams(tree: FilterTree): ProductsListParams {
  const params: ProductsListParams = {}
  const visit = (node: FilterNode): void => {
    if (node.type === "group") {
      for (const child of node.children) visit(child)
      return
    }
    const leaf = node as FilterCondition
    if (typeof leaf.value !== "string" || leaf.value.trim() === "") return
    if (leaf.field === "isActive" && (leaf.operator === "eq" || leaf.operator === "in")) {
      const value = Array.isArray(leaf.value) ? leaf.value[0] : leaf.value
      if (value === "true" || value === "false") params.active = value
      return
    }
    if (
      (leaf.field === "sku" || leaf.field === "name") &&
      (leaf.operator === "contains" || leaf.operator === "eq")
    ) {
      params.query = params.query === undefined ? leaf.value : `${params.query} ${leaf.value}`
    }
  }
  visit(tree)
  return params
}
