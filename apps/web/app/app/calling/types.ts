import type { FilterFieldDef, FilterTree } from "@yourcrm/ui"

/** Call record as returned by `GET /api/v1/calling` (envelope `data` item). */
export type CallRecord = {
  id: string
  workspaceId: string
  ownerId: string | null
  direction: "inbound" | "outbound"
  status: "queued" | "ringing" | "in_progress" | "completed" | "failed" | "no_answer" | "busy"
  source: "manual" | "provider"
  fromNumber: string
  toNumber: string
  personId: string | null
  companyId: string | null
  dealId: string | null
  connectionId: string | null
  providerId: string | null
  providerCallId: string | null
  startedAt: string | null
  endedAt: string | null
  durationSeconds: number | null
  disposition: string | null
  notes: string | null
  recordingConsent: boolean
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

export type CallRecordingRecord = {
  id: string
  callId: string
  url: string
  durationSeconds: number | null
  sizeBytes: number | null
}

export type CallDetail = {
  call: CallRecord
  recordings: CallRecordingRecord[]
}

export type CallListResponse = {
  data: CallRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export const CALL_STATUS_LABELS: Record<CallRecord["status"], string> = {
  queued: "Queued",
  ringing: "Ringing",
  in_progress: "In progress",
  completed: "Completed",
  failed: "Failed",
  no_answer: "No answer",
  busy: "Busy",
}

export function statusTone(
  status: CallRecord["status"],
): "success" | "secondary" | "destructive" | "warning" {
  switch (status) {
    case "completed":
      return "success"
    case "failed":
    case "no_answer":
    case "busy":
      return "destructive"
    case "in_progress":
    case "ringing":
      return "warning"
    default:
      return "secondary"
  }
}

export const CALL_FILTER_FIELDS: FilterFieldDef[] = [
  {
    name: "direction",
    label: "Direction",
    type: "select",
    options: [
      { value: "inbound", label: "Inbound" },
      { value: "outbound", label: "Outbound" },
    ],
  },
  {
    name: "status",
    label: "Status",
    type: "select",
    options: Object.entries(CALL_STATUS_LABELS).map(([value, label]) => ({ value, label })),
  },
  { name: "disposition", label: "Disposition", type: "text" },
]

export type { FilterTree }
