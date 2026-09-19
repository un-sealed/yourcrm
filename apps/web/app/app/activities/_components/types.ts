import type { FilterFieldDef, FilterTree } from "@yourcrm/ui"

/** Activity record as returned by `GET /api/v1/activities` (envelope `data` item). */
export type Activity = {
  id: string
  workspaceId: string
  title: string
  type: string
  subjectType: string | null
  subjectId: string | null
  body: string | null
  status: string
  ownerId: string | null
  dueAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export type ActivitiesListResponse = {
  data: Activity[]
  pagination: { nextCursor: string | null; limit: number }
}

export const ACTIVITY_FILTER_FIELDS: FilterFieldDef[] = [
  { name: "title", label: "Title", type: "text" },
  {
    name: "type",
    label: "Type",
    type: "select",
    options: [
      { value: "note", label: "Note" },
      { value: "call", label: "Call" },
      { value: "meeting", label: "Meeting" },
      { value: "email", label: "Email" },
    ],
  },
  {
    name: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "open", label: "Open" },
      { value: "completed", label: "Completed" },
      { value: "cancelled", label: "Cancelled" },
    ],
  },
]

export type { FilterTree }
