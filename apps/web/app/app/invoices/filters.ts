import type { FilterCondition, FilterNode, FilterTree } from "@yourcrm/ui"

export type InvoicesListParams = {
  query?: string
  status?: string
}

/**
 * Map a UI `FilterTree` onto the P0 list query params (`?query=&status=`).
 * Only `contains` leaves on number/notes fields and `eq` leaves on
 * `status` have server support today; anything else is ignored so the
 * builder stays usable for saved views while structured search grows.
 */
export function treeToInvoiceParams(tree: FilterTree): InvoicesListParams {
  const params: InvoicesListParams = {}
  const visit = (node: FilterNode): void => {
    if (node.type === "group") {
      for (const child of node.children) visit(child)
      return
    }
    const leaf = node as FilterCondition
    if (typeof leaf.value !== "string" || leaf.value.trim() === "") return
    if (leaf.field === "status" && (leaf.operator === "eq" || leaf.operator === "in")) {
      const value = Array.isArray(leaf.value) ? leaf.value[0] : leaf.value
      if (value === "draft" || value === "sent" || value === "paid" || value === "void") {
        params.status = value
      }
      return
    }
    if (
      (leaf.field === "number" || leaf.field === "notes") &&
      (leaf.operator === "contains" || leaf.operator === "eq")
    ) {
      params.query = params.query === undefined ? leaf.value : `${params.query} ${leaf.value}`
    }
  }
  visit(tree)
  return params
}
