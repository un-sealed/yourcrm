import type { BadgeTone } from "@yourcrm/ui"

/**
 * Unified inbox API shapes and presentation helpers (spec 15, P0).
 *
 * The inbox is an AGGREGATOR. It renders a stream and links out; it does not
 * re-implement email threading, the WhatsApp composer or call detail — those
 * live in `/app/email/[id]`, `/app/whatsapp/[id]` and `/app/calling/[id]`, and
 * `inboxItemHref` is the seam that hands off to them.
 *
 * KNOWN GAP (reported, not worked around): assigning a conversation to
 * *another* teammate needs a workspace-members endpoint, and the API exposes
 * none yet. The server accepts any user id on
 * `POST /api/v1/inbox/:channel/:sourceId/assignee`, so the UI here offers the
 * two actions it can express safely — claim (assign to me) and unassign.
 */

export const INBOX_CHANNELS = ["email", "whatsapp", "call"] as const

export type InboxChannel = (typeof INBOX_CHANNELS)[number]

/** One item of `GET /api/v1/inbox` (envelope `data` item). */
export type InboxItem = {
  id: string
  channel: InboxChannel
  sourceId: string
  workspaceId: string
  sortAt: string
  title: string | null
  participant: string | null
  preview: string | null
  direction: string | null
  status: string | null
  personId: string | null
  companyId: string | null
  dealId: string | null
  ownerId: string | null
  assignedTo: string | null
  assignedAt: string | null
  readAt: string | null
  archivedAt: string | null
  unread: boolean
  archived: boolean
}

export type InboxListResponse = {
  data: InboxItem[]
  pagination: { nextCursor: string | null; limit: number }
}

/** Detail route of the module that OWNS the conversation. */
export function inboxItemHref(item: Pick<InboxItem, "channel" | "sourceId">): string {
  switch (item.channel) {
    case "email":
      return `/app/email/${item.sourceId}`
    case "whatsapp":
      return `/app/whatsapp/${item.sourceId}`
    case "call":
      return `/app/calling/${item.sourceId}`
  }
}

export const INBOX_CHANNEL_LABELS: Record<InboxChannel, string> = {
  email: "Email",
  whatsapp: "WhatsApp",
  call: "Call",
}

/** Tone is colour PLUS the channel word — never colour alone (a11y). */
export function inboxChannelTone(channel: InboxChannel): BadgeTone {
  switch (channel) {
    case "email":
      return "info"
    case "whatsapp":
      return "success"
    case "call":
      return "warning"
  }
}

/** Best human label for the other party in the conversation. */
export function inboxItemHeadline(item: InboxItem): string {
  const parts = [item.title, item.participant].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  )
  if (parts.length === 0) return `${INBOX_CHANNEL_LABELS[item.channel]} conversation`
  return parts[0] ?? ""
}

export function inboxItemSubline(item: InboxItem): string {
  const headline = inboxItemHeadline(item)
  if (item.participant && item.participant !== headline) return item.participant
  return item.preview ?? "No preview available"
}

export function formatInboxTimestamp(value: string | null): string {
  if (!value) return "—"
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return "—"
  return parsed.toLocaleString()
}

/** Query-string builder for the stream. Mirrors `inboxItemQuerySchema`. */
export type InboxFilters = {
  channel: "" | InboxChannel
  readState: "" | "unread" | "read"
  assigned: "anyone" | "me" | "unassigned"
  archived: boolean
}

export const DEFAULT_INBOX_FILTERS: InboxFilters = {
  channel: "",
  readState: "",
  assigned: "anyone",
  archived: false,
}

export function inboxQueryString(filters: InboxFilters, cursor: string | null, limit = 25): string {
  const params = new URLSearchParams({ limit: String(limit) })
  if (filters.channel) params.set("channel", filters.channel)
  if (filters.readState) params.set("unread", filters.readState === "unread" ? "true" : "false")
  if (filters.assigned !== "anyone") params.set("assigned", filters.assigned)
  if (filters.archived) params.set("archived", "true")
  if (cursor) params.set("cursor", cursor)
  return params.toString()
}
