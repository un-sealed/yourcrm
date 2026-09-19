import type { FilterCondition, FilterNode, FilterTree } from "@yourcrm/ui"
import type { CustomObjectFieldDef } from "./types"

export type CustomObjectRecordParams = {
  query?: string
  field?: string
  value?: string
}

/**
 * Map a UI `FilterTree` onto the record-list query params.
 *
 * P0 server support is one exact field match (`?field=&value=`) plus a
 * display-name search (`?query=`). Leaves the API cannot serve are ignored
 * rather than faked client-side, so a saved view never silently shows a
 * different result set than the server would return. Unknown field names
 * are dropped here too — the server rejects them with a 400, and there is
 * no reason to send a request that is known to fail.
 */
export function treeToCustomObjectParams(
  tree: FilterTree,
  fields: CustomObjectFieldDef[],
): CustomObjectRecordParams {
  const params: CustomObjectRecordParams = {}
  const known = new Map(fields.map((field) => [field.key, field]))

  const visit = (node: FilterNode): void => {
    if (node.type === "group") {
      for (const child of node.children) visit(child)
      return
    }
    const leaf: FilterCondition = node
    const field = known.get(leaf.field)
    if (!field) return
    const value = normalizeLeafValue(leaf.value)
    if (value === null) return
    if (leaf.operator === "eq" && params.field === undefined) {
      params.field = field.key
      params.value = value
      return
    }
    if (leaf.operator === "contains" && params.query === undefined) {
      params.query = value
    }
  }

  visit(tree)
  return params
}

function normalizeLeafValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed === "" ? null : trimmed
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (typeof value === "boolean") return String(value)
  return null
}
