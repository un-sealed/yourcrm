/**
 * The WhatsApp Business "24-hour customer service window" (spec 16-whatsapp).
 *
 * Meta's rule: a business may send free-form messages to a contact only
 * within 24 hours of that contact's LAST INBOUND message. Outside the
 * window, only a pre-approved template message can re-open the
 * conversation. This is enforced here, server-side, in the domain service
 * (`service.ts`'s `sendMessage`) — never trust a client to have checked it.
 */
export const WHATSAPP_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Whether free-form text may be sent right now.
 *
 * The boundary is exclusive: exactly 24h00m00.000s after the last inbound
 * message, the window is already CLOSED (`elapsed < WINDOW_MS`, not `<=`).
 * A conversation that has never received an inbound message (`lastInboundAt`
 * is null/undefined) has no open window — it can only be opened with a
 * template, same as a real first-contact WhatsApp conversation.
 */
export function isWhatsAppSessionWindowOpen(
  lastInboundAt: Date | string | null | undefined,
  now: Date,
): boolean {
  if (lastInboundAt === null || lastInboundAt === undefined) return false
  const last = lastInboundAt instanceof Date ? lastInboundAt : new Date(lastInboundAt)
  if (Number.isNaN(last.getTime())) return false
  return now.getTime() - last.getTime() < WHATSAPP_SESSION_WINDOW_MS
}

/** Milliseconds until the window closes; negative/zero once it has closed. */
export function whatsAppSessionWindowRemainingMs(
  lastInboundAt: Date | string | null | undefined,
  now: Date,
): number {
  if (lastInboundAt === null || lastInboundAt === undefined) return 0
  const last = lastInboundAt instanceof Date ? lastInboundAt : new Date(lastInboundAt)
  if (Number.isNaN(last.getTime())) return 0
  return WHATSAPP_SESSION_WINDOW_MS - (now.getTime() - last.getTime())
}
