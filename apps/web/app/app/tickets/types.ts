import type { FilterFieldDef, FilterTree } from "@yourcrm/ui"

/** Ticket record as returned by `GET /api/v1/tickets` (envelope `data` item). */
export type SupportTicket = {
  id: string
  workspaceId: string
  subject: string
  description: string | null
  status: "new" | "open" | "pending" | "resolved" | "closed"
  priority: "low" | "normal" | "high" | "urgent"
  requesterId: string
  assigneeId: string | null
  channel: "email" | "chat" | "whatsapp" | "phone" | "web" | "api" | "manual"
  firstResponseDueAt: string | null
  firstResponseAt: string | null
  resolutionDueAt: string | null
  resolvedAt: string | null
  closedAt: string | null
  createdAt: string
  updatedAt: string
}

export type SupportTicketComment = {
  id: string
  ticketId: string
  authorId: string
  body: string
  isInternal: boolean
  createdAt: string
  updatedAt: string
}

export type SupportTicketDetail = SupportTicket & {
  comments: SupportTicketComment[]
}

export type SupportTicketListResponse = {
  data: SupportTicket[]
  pagination: { nextCursor: string | null; limit: number }
}

export const SUPPORT_TICKET_STATUS_OPTIONS: { value: SupportTicket["status"]; label: string }[] = [
  { value: "new", label: "New" },
  { value: "open", label: "Open" },
  { value: "pending", label: "Pending" },
  { value: "resolved", label: "Resolved" },
  { value: "closed", label: "Closed" },
]

export const SUPPORT_TICKET_PRIORITY_OPTIONS: {
  value: SupportTicket["priority"]
  label: string
}[] = [
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
]

export const SUPPORT_TICKET_CHANNEL_OPTIONS: {
  value: SupportTicket["channel"]
  label: string
}[] = [
  { value: "manual", label: "Manual" },
  { value: "email", label: "Email" },
  { value: "chat", label: "Chat" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "phone", label: "Phone" },
  { value: "web", label: "Web" },
  { value: "api", label: "API" },
]

/** Valid next statuses per current status — mirrors the server's transition table. */
export const SUPPORT_TICKET_NEXT_STATUSES: Record<
  SupportTicket["status"],
  SupportTicket["status"][]
> = {
  new: ["open", "resolved", "closed"],
  open: ["pending", "resolved", "closed"],
  pending: ["open", "resolved", "closed"],
  resolved: ["closed", "open"],
  closed: ["open"],
}

export function statusTone(
  status: SupportTicket["status"],
): "success" | "secondary" | "warning" | "info" {
  if (status === "resolved") return "success"
  if (status === "closed") return "secondary"
  if (status === "pending") return "warning"
  return "info"
}

export function priorityTone(
  priority: SupportTicket["priority"],
): "secondary" | "warning" | "destructive" {
  if (priority === "urgent") return "destructive"
  if (priority === "high") return "warning"
  return "secondary"
}

export const TICKET_FILTER_FIELDS: FilterFieldDef[] = [
  { name: "subject", label: "Subject", type: "text" },
  {
    name: "status",
    label: "Status",
    type: "select",
    options: SUPPORT_TICKET_STATUS_OPTIONS,
  },
  {
    name: "priority",
    label: "Priority",
    type: "select",
    options: SUPPORT_TICKET_PRIORITY_OPTIONS,
  },
]

export type { FilterTree }
