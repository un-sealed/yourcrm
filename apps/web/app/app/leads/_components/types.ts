import type { BadgeTone, FilterFieldDef, FilterTree } from "@yourcrm/ui"

/** Lead record as returned by `GET /api/v1/leads` (envelope `data` item). */
export type Lead = {
  id: string
  workspaceId: string
  firstName: string
  lastName: string | null
  email: string | null
  phone: string | null
  companyName: string | null
  title: string | null
  source: string
  status: string
  score: number
  ownerId: string | null
  notes: string | null
  personId: string | null
  companyId: string | null
  dealId: string | null
  createdAt: string
  updatedAt: string
}

export type LeadsListResponse = {
  data: Lead[]
  pagination: { nextCursor: string | null; limit: number }
}

export function displayName(lead: Pick<Lead, "firstName" | "lastName">): string {
  return [lead.firstName, lead.lastName].filter((part) => part !== null && part !== "").join(" ")
}

export const LEAD_STATUSES = ["new", "working", "qualified", "unqualified", "converted"] as const

export const LEAD_SOURCES = [
  "manual",
  "form",
  "meta",
  "google",
  "whatsapp",
  "indiamart",
  "justdial",
  "tradeindia",
] as const

export function statusTone(status: string): BadgeTone {
  switch (status) {
    case "qualified":
      return "success"
    case "working":
      return "warning"
    case "new":
      return "info"
    case "converted":
      return "default"
    default:
      return "secondary"
  }
}

export const LEAD_FILTER_FIELDS: FilterFieldDef[] = [
  { name: "firstName", label: "First name", type: "text" },
  { name: "lastName", label: "Last name", type: "text" },
  { name: "companyName", label: "Company", type: "text" },
  {
    name: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "new", label: "New" },
      { value: "working", label: "Working" },
      { value: "qualified", label: "Qualified" },
      { value: "unqualified", label: "Unqualified" },
      { value: "converted", label: "Converted" },
    ],
  },
  {
    name: "source",
    label: "Source",
    type: "select",
    options: [
      { value: "manual", label: "Manual" },
      { value: "form", label: "Form" },
      { value: "meta", label: "Meta" },
      { value: "google", label: "Google" },
      { value: "whatsapp", label: "WhatsApp" },
      { value: "indiamart", label: "IndiaMART" },
      { value: "justdial", label: "JustDial" },
      { value: "tradeindia", label: "TradeIndia" },
    ],
  },
]

export type { FilterTree }
