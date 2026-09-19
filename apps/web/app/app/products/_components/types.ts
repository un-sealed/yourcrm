import type { FilterFieldDef } from "@yourcrm/ui"

/** Product record as returned by `GET /api/v1/products` (envelope `data` item). */
export type Product = {
  id: string
  workspaceId: string
  sku: string
  name: string
  description: string | null
  ownerId: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export type ProductListResponse = {
  data: Product[]
  pagination: { nextCursor: string | null; limit: number }
}

export const PRODUCT_FILTER_FIELDS: FilterFieldDef[] = [
  { name: "sku", label: "SKU", type: "text" },
  { name: "name", label: "Name", type: "text" },
  {
    name: "isActive",
    label: "Active",
    type: "select",
    options: [
      { value: "true", label: "Active" },
      { value: "false", label: "Inactive" },
    ],
  },
]
