import type { FilterFieldDef, FilterTree } from "@yourcrm/ui"

/** Person record as returned by `GET /api/v1/people` (envelope `data` item). */
export type Person = {
  id: string
  workspaceId: string
  firstName: string
  lastName: string | null
  title: string | null
  companyId: string | null
  ownerId: string | null
  status: string
  preferredChannel: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
}

export type PersonEmail = {
  id: string
  email: string
  label: string | null
  isPrimary: boolean
}

export type PersonPhone = {
  id: string
  phone: string
  label: string | null
  isPrimary: boolean
}

export type PersonDetail = Person & {
  emails: PersonEmail[]
  phones: PersonPhone[]
}

export type PeopleListResponse = {
  data: Person[]
  pagination: { nextCursor: string | null; limit: number }
}

export function displayName(person: Pick<Person, "firstName" | "lastName">): string {
  return [person.firstName, person.lastName]
    .filter((part) => part !== null && part !== "")
    .join(" ")
}

export const PERSON_FILTER_FIELDS: FilterFieldDef[] = [
  { name: "firstName", label: "First name", type: "text" },
  { name: "lastName", label: "Last name", type: "text" },
  { name: "title", label: "Title", type: "text" },
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
