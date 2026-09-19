import type { FilterCondition, FilterNode, FilterTree } from "@yourcrm/ui"

export type CallingListParams = {
  direction?: "inbound" | "outbound"
  status?: string
  query?: string
}

/**
 * Map a UI `FilterTree` onto the P0 list query params
 * (`?direction=&status=&query=`). Only AND-grouped `eq` leaves on
 * direction/status and `contains`/`eq` on disposition have server support
 * today — mirrors `apps/web/app/app/people/filters.ts`.
 */
export function treeToCallingParams(tree: FilterTree): CallingListParams {
  const params: CallingListParams = {}
  const visit = (node: FilterNode): void => {
    if (node.type === "group") {
      for (const child of node.children) visit(child)
      return
    }
    const leaf = node as FilterCondition
    if (typeof leaf.value !== "string" || leaf.value.trim() === "") return
    if (leaf.field === "direction" && leaf.operator === "eq") {
      if (leaf.value === "inbound" || leaf.value === "outbound") params.direction = leaf.value
      return
    }
    if (leaf.field === "status" && leaf.operator === "eq") {
      params.status = leaf.value
      return
    }
    if (leaf.field === "disposition" && (leaf.operator === "contains" || leaf.operator === "eq")) {
      params.query = params.query === undefined ? leaf.value : `${params.query} ${leaf.value}`
    }
  }
  visit(tree)
  return params
}
