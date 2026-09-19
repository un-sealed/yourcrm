/** WhatsApp conversation as returned by `GET /api/v1/whatsapp/conversations` (envelope `data` item). */
export type WhatsAppConversation = {
  id: string
  workspaceId: string
  connectionId: string
  contactPhone: string
  personId: string | null
  companyId: string | null
  status: string
  lastInboundAt: string | null
  lastOutboundAt: string | null
  lastMessageAt: string | null
  lastMessagePreview: string | null
  unreadCount: number
  createdAt: string
  updatedAt: string
}

export type WhatsAppMessage = {
  id: string
  workspaceId: string
  conversationId: string
  direction: "inbound" | "outbound"
  kind: string
  body: string | null
  templateId: string | null
  templateVariables: string[] | null
  mediaStorageKey: string | null
  mediaContentType: string | null
  mediaFileName: string | null
  mediaSizeBytes: number | null
  providerMessageId: string | null
  status: "queued" | "sent" | "failed" | "delivered" | "read"
  statusUpdatedAt: string | null
  sentAt: string | null
  deliveredAt: string | null
  readAt: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

export type WhatsAppTemplate = {
  id: string
  workspaceId: string
  connectionId: string
  name: string
  language: string
  category: string | null
  status: string
  bodyText: string
  variableCount: number
  createdAt: string
  updatedAt: string
}

export type WhatsAppConversationListResponse = {
  data: WhatsAppConversation[]
  pagination: { nextCursor: string | null; limit: number }
}

export type WhatsAppMessageListResponse = {
  data: WhatsAppMessage[]
  pagination: { nextCursor: string | null; limit: number }
}

export type WhatsAppTemplateListResponse = {
  data: WhatsAppTemplate[]
  pagination: { nextCursor: string | null; limit: number }
}

/**
 * The WhatsApp Business 24-hour customer service window, mirrored from
 * `packages/crm/src/whatsapp/session-window.ts` (the web app talks to the
 * API only — see `docs/architecture.md` — so this is a small, deliberate
 * client-side duplicate used ONLY to drive UI affordances; the server is
 * the enforcement point and re-checks this on every send).
 */
export const WHATSAPP_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000

export function isWhatsAppSessionWindowOpen(
  lastInboundAt: string | null,
  now: Date = new Date(),
): boolean {
  if (!lastInboundAt) return false
  const last = new Date(lastInboundAt)
  if (Number.isNaN(last.getTime())) return false
  return now.getTime() - last.getTime() < WHATSAPP_SESSION_WINDOW_MS
}

export function contactLabel(conversation: Pick<WhatsAppConversation, "contactPhone">): string {
  return conversation.contactPhone
}
