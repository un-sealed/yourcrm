import type { FilterCondition, FilterFieldDef, FilterNode, FilterTree } from "@yourcrm/ui"

export type { FilterTree }

/**
 * Module-local list/detail model for the forms UI (spec 23-forms, P0).
 *
 * Lives under `_components/` because Next.js route modules (`page.tsx`)
 * may only export the default component — the shared types, filter fields
 * and tree mapping live here instead (the people module keeps them in
 * sibling `types.ts` / `filters.ts` files).
 */

export type Form = {
  id: string
  workspaceId: string
  name: string
  description: string | null
  status: string
  publicId: string
  successMessage: string | null
  ownerId: string | null
  createdAt: string
  updatedAt: string
}

export type FormsListResponse = {
  data: Form[]
  pagination: { nextCursor: string | null; limit: number }
}

export type FormField = {
  id: string
  formId: string
  label: string
  fieldType: string
  required: boolean
  position: number
  placeholder: string | null
  options: string[] | null
  helpText: string | null
}

export type FormDetail = Form & {
  fields: FormField[]
}

export type FormSubmission = {
  id: string
  formId: string
  values: Record<string, unknown>
  submitterEmail: string | null
  leadId: string | null
  createdAt: string
}

export type SubmissionsListResponse = {
  data: FormSubmission[]
  pagination: { nextCursor: string | null; limit: number }
}

export const FORM_FILTER_FIELDS: FilterFieldDef[] = [
  { name: "name", label: "Name", type: "text" },
  {
    name: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "draft", label: "Draft" },
      { value: "published", label: "Published" },
      { value: "archived", label: "Archived" },
    ],
  },
]

export type FormsListParams = {
  query?: string
  status?: string
}

/**
 * Map a UI `FilterTree` onto the P0 list query params (`?query=&status=`).
 * Only `contains` leaves on the name field and `eq` leaves on `status` have
 * server support today; anything else is ignored so the builder stays usable
 * for saved views while structured search grows.
 */
export function treeToFormsParams(tree: FilterTree): FormsListParams {
  const params: FormsListParams = {}
  const visit = (node: FilterNode): void => {
    if (node.type === "group") {
      for (const child of node.children) visit(child)
      return
    }
    const leaf = node as FilterCondition
    if (typeof leaf.value !== "string" || leaf.value.trim() === "") return
    if (leaf.field === "status" && (leaf.operator === "eq" || leaf.operator === "in")) {
      const value = Array.isArray(leaf.value) ? leaf.value[0] : leaf.value
      if (value === "draft" || value === "published" || value === "archived") {
        params.status = value
      }
      return
    }
    if (leaf.field === "name" && (leaf.operator === "contains" || leaf.operator === "eq")) {
      params.query = params.query === undefined ? leaf.value : `${params.query} ${leaf.value}`
    }
  }
  visit(tree)
  return params
}

export const FORM_STATUS_TONES: Record<string, "success" | "secondary" | "warning"> = {
  published: "success",
  draft: "secondary",
  archived: "warning",
}
