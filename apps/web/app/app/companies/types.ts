import type { FilterFieldDef, FilterTree } from "@yourcrm/ui"

/** Company record as returned by `GET /api/v1/companies` (envelope `data` item). */
export type Company = {
  id: string
  workspaceId: string
  name: string
  domain: string | null
  website: string | null
  industry: string | null
  size: string | null
  ownerId: string | null
  parentCompanyId: string | null
  status: string
  description: string | null
  createdAt: string
  updatedAt: string
}

export type CompanyAddress = {
  id: string
  label: string | null
  line1: string | null
  city: string | null
  region: string | null
  postalCode: string | null
  country: string | null
  isPrimary: boolean
}

export type CompanyDetail = Company & {
  addresses: CompanyAddress[]
  children: Company[]
}

/** Person row (subset) as returned by `GET /api/v1/people`, for the people-at-company list. */
export type CompanyPerson = {
  id: string
  firstName: string
  lastName: string | null
  title: string | null
  companyId: string | null
}

export type CompaniesListResponse = {
  data: Company[]
  pagination: { nextCursor: string | null; limit: number }
}

export const COMPANY_FILTER_FIELDS: FilterFieldDef[] = [
  { name: "name", label: "Name", type: "text" },
  { name: "domain", label: "Domain", type: "text" },
  { name: "industry", label: "Industry", type: "text" },
  {
    name: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "active", label: "Active" },
      { value: "archived", label: "Archived" },
    ],
  },
]

export type { FilterTree }
