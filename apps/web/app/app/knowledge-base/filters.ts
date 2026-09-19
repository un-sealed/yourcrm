import type { FilterCondition, FilterNode, FilterTree } from "@yourcrm/ui"

export type KbArticleListParams = {
  query?: string
  status?: string
}

/**
 * Map a UI `FilterTree` onto the P0 list query params (`?query=&status=`).
 * Only AND-grouped `contains`/`eq` leaves on `title` and `eq` leaves on
 * `status` have server support today (mirrors `people/filters.ts`).
 */
export function treeToKbArticleParams(tree: FilterTree): KbArticleListParams {
  const params: KbArticleListParams = {}
  const visit = (node: FilterNode): void => {
    if (node.type === "group") {
      for (const child of node.children) visit(child)
      return
    }
    const leaf = node as FilterCondition
    if (typeof leaf.value !== "string" || leaf.value.trim() === "") return
    if (leaf.field === "status" && (leaf.operator === "eq" || leaf.operator === "in")) {
      const value = Array.isArray(leaf.value) ? leaf.value[0] : leaf.value
      if (value === "draft" || value === "published" || value === "archived") params.status = value
      return
    }
    if (leaf.field === "title" && (leaf.operator === "contains" || leaf.operator === "eq")) {
      params.query = params.query === undefined ? leaf.value : `${params.query} ${leaf.value}`
    }
  }
  visit(tree)
  return params
}
