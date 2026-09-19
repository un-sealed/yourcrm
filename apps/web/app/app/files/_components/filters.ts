import type { FilterCondition, FilterNode, FilterTree } from "@yourcrm/ui"

export type FilesListParams = {
  query?: string
  mimeType?: string
  subjectType?: string
}

/**
 * Map a UI `FilterTree` onto the P0 list query params
 * (`?query=&mimeType=&subjectType=`). Only `contains` leaves on name/type
 * fields and `eq` leaves on `subjectType` have server support today;
 * anything else is ignored so the builder stays usable for saved views
 * while structured search grows.
 */
export function treeToFilesParams(tree: FilterTree): FilesListParams {
  const params: FilesListParams = {}
  const visit = (node: FilterNode): void => {
    if (node.type === "group") {
      for (const child of node.children) visit(child)
      return
    }
    const leaf = node as FilterCondition
    if (typeof leaf.value !== "string" || leaf.value.trim() === "") return
    if (leaf.field === "subjectType" && (leaf.operator === "eq" || leaf.operator === "in")) {
      const value = Array.isArray(leaf.value) ? leaf.value[0] : leaf.value
      if (value === "person" || value === "company" || value === "deal") {
        params.subjectType = value
      }
      return
    }
    if (
      (leaf.field === "fileName" || leaf.field === "mimeType") &&
      (leaf.operator === "contains" || leaf.operator === "eq")
    ) {
      if (leaf.field === "mimeType" && leaf.operator === "eq") {
        params.mimeType = leaf.value
        return
      }
      params.query = params.query === undefined ? leaf.value : `${params.query} ${leaf.value}`
    }
  }
  visit(tree)
  return params
}
