import type { BadgeTone } from "@yourcrm/ui"

/**
 * Email API shapes as returned by `/api/v1/email/*`.
 *
 * NOTE ON `bodyHtml`: there is deliberately no such field here, because the
 * API deliberately does not return one. Inbound bodies are
 * attacker-controlled, so the server flattens them to text (sanitising
 * script/style/iframe/handler content on the way) and the UI renders that
 * text through React's normal escaping. Nothing in this module calls
 * `dangerouslySetInnerHTML`. See `packages/crm/src/email/sanitize.ts`.
 */

export type EmailThreadSummary = {
  id: string
  workspaceId: string
  subject: string | null
  status: string
  messageCount: number
  lastMessageAt: string | null
  personId: string | null
  companyId: string | null
  dealId: string | null
  createdAt: string
  updatedAt: string
}

export type EmailMessageParticipant = {
  id: string
  role: string
  address: string
  displayName: string | null
  personId: string | null
}

export type EmailMessageAttachmentMeta = {
  id: string
  fileName: string
  mimeType: string | null
  sizeBytes?: number
  storageKey: string | null
  isInline?: boolean
}

export type EmailMessageSummary = {
  id: string
  threadId: string
  direction: string
  status: string
  subject: string | null
  fromAddress: string | null
  fromName: string | null
  /** Plain text only — see the note at the top of this file. */
  bodyText: string | null
  snippet: string | null
  hasAttachments?: boolean
  providerMessageId: string | null
  sentAt: string | null
  receivedAt: string | null
  lastError: string | null
  createdAt: string
}

export type EmailMessageDetailResponse = {
  message: EmailMessageSummary
  participants: EmailMessageParticipant[]
  attachments: EmailMessageAttachmentMeta[]
}

export type EmailThreadDetailResponse = {
  thread: EmailThreadSummary
  messages: EmailMessageDetailResponse[]
}

export type EmailThreadListResponse = {
  data: EmailThreadSummary[]
  pagination: { nextCursor: string | null; limit: number }
}

export const EMAIL_THREAD_STATUS_OPTIONS = [
  { value: "", label: "All" },
  { value: "open", label: "Open" },
  { value: "archived", label: "Archived" },
]

/** Human label for a thread with no subject line. */
export function emailThreadTitle(thread: Pick<EmailThreadSummary, "subject">): string {
  const subject = thread.subject?.trim() ?? ""
  return subject.length === 0 ? "(no subject)" : subject
}

/** `"Ada Lovelace <ada@example.com>"`, or just the address. */
export function emailParticipantLabel(
  participant: Pick<EmailMessageParticipant, "address" | "displayName">,
): string {
  const name = participant.displayName?.trim() ?? ""
  return name.length === 0 ? participant.address : `${name} <${participant.address}>`
}

/** Recipients of one role, in order, as a comma-separated line. */
export function emailRecipientsLine(
  participants: readonly EmailMessageParticipant[],
  role: string,
): string {
  return participants
    .filter((participant) => participant.role === role)
    .map((participant) => participant.address)
    .join(", ")
}

/** The sender line for a message, preferring the participant row. */
export function emailSenderLabel(detail: EmailMessageDetailResponse): string {
  const from = detail.participants.find((participant) => participant.role === "from")
  if (from) return emailParticipantLabel(from)
  const name = detail.message.fromName?.trim() ?? ""
  const address = detail.message.fromAddress ?? "unknown sender"
  return name.length === 0 ? address : `${name} <${address}>`
}

/**
 * Split a comma/semicolon/whitespace separated recipient box into address
 * objects for the API. Invalid entries are returned separately so the form
 * can point at them instead of failing server-side.
 */
export function parseEmailRecipients(input: string): {
  valid: { address: string }[]
  invalid: string[]
} {
  const parts = input
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  const valid: { address: string }[] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  for (const part of parts) {
    const address = part.toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      invalid.push(part)
      continue
    }
    if (seen.has(address)) continue
    seen.add(address)
    valid.push({ address })
  }
  return { valid, invalid }
}

/** Short, locale-aware timestamp. Falls back to the raw value. */
export function formatEmailTimestamp(value: string | null): string {
  if (value === null) return "—"
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString()
}

/** Badge tone for a delivery status. Tone is paired with the status text. */
export function emailStatusTone(status: string): BadgeTone {
  if (status === "sent" || status === "delivered" || status === "received") return "success"
  if (status === "queued") return "warning"
  if (status === "failed" || status === "bounced") return "destructive"
  return "secondary"
}
