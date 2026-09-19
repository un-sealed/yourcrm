import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { IntegrationProviderPort, IntegrationWebhookHandlerResult } from "../integrations"
import { emailAddressInputSchema, emailAttachmentInputSchema } from "./schemas"
import type { InboundEmailMessageInput } from "./schemas"
import type {
  EmailTransportContext,
  EmailTransportPort,
  EmailTransportSendInput,
  EmailTransportSendResult,
} from "./types"

/**
 * The console email provider — a REQUIRED part of the module, not a toy.
 *
 * It implements the full email provider contract with no vendor, no network
 * and no real credentials, so the whole round trip (connect -> send ->
 * signed inbound webhook -> thread) is exercisable in tests, in CI and on a
 * laptop with nothing but Postgres running. Every vendor adapter (Resend,
 * SES, Postmark, …) is this file with `sendEmail()` doing an HTTP POST and
 * `connect()` calling the vendor's whoami; nothing else changes.
 *
 * TWO CONTRACTS, ONE OBJECT
 * -------------------------
 * - `IntegrationProviderPort` — lifecycle (`connect`/`disconnect`/
 *   `healthCheck`) plus the inbound `webhook` spec. The integrations
 *   framework owns connection rows, sealed credentials, constant-time HMAC
 *   verification and provider-event-id deduplication; this file declares
 *   WHERE the signature is and WHAT to do with a verified payload, and
 *   verifies nothing itself.
 * - `EmailTransportPort` — the outbound half the email service calls with a
 *   decrypted secret that lives for exactly that call.
 *
 * Keeping both on one object means a single registration in the connector
 * registry makes a provider both sendable and receivable.
 *
 * IDEMPOTENCY: `handle()` may be re-invoked for a delivery that previously
 * failed. It never mutates anything itself — it hands a structured message
 * to `onInboundEmail`, and `emailService.receiveInboundEmail()` de-duplicates
 * on the RFC 5322 Message-ID. When a payload carries no Message-ID, one is
 * synthesised deterministically from the framework's `providerEventId`, so
 * a retry still resolves to the same row.
 */

export const CONSOLE_EMAIL_PROVIDER_ID = "console-email"

/** Non-secret settings for a console mailbox. */
export const consoleEmailConfigSchema = z.object({
  /** Default envelope sender when a send does not name one. */
  fromAddress: z.string().trim().toLowerCase().email().max(320),
  fromName: z.string().trim().max(255).optional(),
  /**
   * Recipient domains this mailbox may send to. Empty means "anywhere" —
   * set it in shared dev environments so a test send cannot reach a real
   * inbox.
   */
  allowedRecipientDomains: z.array(z.string().trim().toLowerCase().max(253)).max(50).default([]),
})

export type ConsoleEmailConfig = z.infer<typeof consoleEmailConfigSchema>

/** The structured inbound payload this provider accepts on its webhook. */
export const consoleInboundEmailPayloadSchema = z.object({
  /** Provider event id — also the framework's idempotency key. */
  id: z.string().trim().min(1).max(255).optional(),
  type: z.string().trim().min(1).max(128).default("email.received"),
  message: z.object({
    messageId: z.string().trim().max(998).nullish(),
    inReplyTo: z.string().trim().max(998).nullish(),
    references: z.union([z.string().max(8000), z.array(z.string().max(998)).max(200)]).nullish(),
    subject: z.string().max(998).nullish(),
    from: emailAddressInputSchema,
    to: z.array(emailAddressInputSchema).max(200).default([]),
    cc: z.array(emailAddressInputSchema).max(200).default([]),
    bcc: z.array(emailAddressInputSchema).max(200).default([]),
    replyTo: emailAddressInputSchema.nullish(),
    bodyText: z.string().max(1_000_000).nullish(),
    bodyHtml: z.string().max(2_000_000).nullish(),
    attachments: z.array(emailAttachmentInputSchema).max(50).default([]),
    receivedAt: z.coerce.date().nullish(),
  }),
})

export type ConsoleInboundEmailPayload = z.infer<typeof consoleInboundEmailPayloadSchema>

/** One send captured by the console provider instead of leaving the box. */
export type ConsoleEmailOutboxEntry = {
  connectionId: string
  workspaceId: string
  providerMessageId: string
  sentAt: Date
  input: EmailTransportSendInput
}

export type ConsoleEmailProviderOptions = {
  /**
   * Called for each verified, de-duplicated inbound delivery — wire it to
   * `emailService.receiveInboundEmail`.
   */
  onInboundEmail?: (input: InboundEmailMessageInput) => Promise<unknown>
  /** Called for each captured send. Defaults to a single log line. */
  onOutboundEmail?: (entry: ConsoleEmailOutboxEntry) => void
  /** How many sends to keep in the in-memory outbox. Default 100. */
  outboxLimit?: number
  now?: () => Date
  newProviderMessageId?: () => string
  /** Log captured sends to stdout. Default true. */
  log?: boolean
}

/** Provider + transport, as one registrable object. */
export type ConsoleEmailProvider = IntegrationProviderPort &
  EmailTransportPort & {
    /** Sends captured in this process. Test/dev affordance only. */
    readonly outbox: readonly ConsoleEmailOutboxEntry[]
    clearOutbox(): void
  }

function domainOf(address: string): string {
  const at = address.lastIndexOf("@")
  return at === -1 ? "" : address.slice(at + 1).toLowerCase()
}

function readAllowedDomains(config: Record<string, unknown>): string[] {
  const value = config.allowedRecipientDomains
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

export function createConsoleEmailProvider(
  options: ConsoleEmailProviderOptions = {},
): ConsoleEmailProvider {
  const now = options.now ?? (() => new Date())
  const newProviderMessageId = options.newProviderMessageId ?? (() => `console-${randomUUID()}`)
  const outboxLimit = options.outboxLimit ?? 100
  const outbox: ConsoleEmailOutboxEntry[] = []

  return {
    id: CONSOLE_EMAIL_PROVIDER_ID,
    displayName: "Console Email (development)",
    description:
      "Captures outgoing mail in memory instead of delivering it, and accepts HMAC-signed inbound messages. Use it to exercise email end to end without a vendor account.",
    category: "email",
    capabilities: ["email.send", "email.receive"],
    // P0 is API-key only. OAuth is NOT implemented anywhere in this
    // deployment — see the extension-point note at the bottom of
    // packages/integrations/src/provider.ts.
    authKind: "api_key",
    configSchema: consoleEmailConfigSchema,
    secretLabel: "Dev token",

    webhook: {
      // The framework verifies this in constant time against the
      // connection's stored webhook_secret BEFORE handle() is called. This
      // file must not, and does not, compute an HMAC.
      signatureHeader: "x-yourcrm-signature",
      algorithm: "sha256",
      encoding: "hex",
      signaturePrefix: "sha256=",
      eventIdHeader: "x-yourcrm-event-id",
      extractEventId: (payload) => {
        if (typeof payload !== "object" || payload === null) return null
        const id = (payload as Record<string, unknown>).id
        return typeof id === "string" && id.length > 0 ? id : null
      },
      extractEventType: (payload) => {
        if (typeof payload !== "object" || payload === null) return null
        const type = (payload as Record<string, unknown>).type
        return typeof type === "string" && type.length > 0 ? type : null
      },
      handle: async (delivery): Promise<IntegrationWebhookHandlerResult> => {
        const parsed = consoleInboundEmailPayloadSchema.safeParse(delivery.payload)
        if (!parsed.success) {
          // Not an email delivery (a ping, a status callback): ignore it
          // rather than failing, so the framework does not retry forever.
          return {
            status: "ignored",
            eventType: delivery.eventType,
            detail: "payload is not an inbound email",
          }
        }
        if (parsed.data.type !== "email.received") {
          return { status: "ignored", eventType: parsed.data.type, detail: "unsupported event" }
        }

        const message = parsed.data.message
        // No Message-ID? Derive one from the framework's idempotency key so
        // a re-delivered event still de-duplicates downstream.
        const messageId =
          message.messageId ?? `${delivery.providerEventId}@${CONSOLE_EMAIL_PROVIDER_ID}.invalid`

        await options.onInboundEmail?.({
          workspaceId: delivery.workspaceId,
          connectionId: delivery.connectionId,
          providerId: delivery.providerId,
          providerMessageId: parsed.data.id ?? delivery.providerEventId,
          messageId,
          inReplyTo: message.inReplyTo ?? null,
          references: message.references ?? null,
          subject: message.subject ?? null,
          from: message.from,
          to: message.to,
          cc: message.cc,
          bcc: message.bcc,
          replyTo: message.replyTo ?? null,
          bodyText: message.bodyText ?? null,
          bodyHtml: message.bodyHtml ?? null,
          attachments: message.attachments,
          receivedAt: message.receivedAt ?? null,
          correlationId: null,
        })
        return { status: "processed", eventType: parsed.data.type }
      },
    },

    /** No network: verify the token looks like one and report the mailbox. */
    connect: async ({ secret, config }) => {
      if (!secret || secret.trim().length < 8) {
        throw new Error("dev token must be at least 8 characters")
      }
      const parsed = consoleEmailConfigSchema.parse(config)
      return {
        externalAccountId: parsed.fromAddress,
        scopes: ["email.send", "email.receive"],
      }
    },

    disconnect: async () => undefined,

    healthCheck: async ({ secret }) =>
      secret
        ? { status: "connected", message: "console provider: mail is captured, not delivered" }
        : { status: "error", message: "no dev token stored for this connection" },

    /* --------------------------- transport --------------------------- */

    async sendEmail(
      input: EmailTransportSendInput,
      ctx: EmailTransportContext,
    ): Promise<EmailTransportSendResult> {
      if (!ctx.secret) throw new Error("console email provider: connection has no dev token")

      const allowed = readAllowedDomains(ctx.config)
      if (allowed.length > 0) {
        const blocked = [...input.to, ...input.cc, ...input.bcc]
          .map((recipient) => domainOf(recipient.address))
          .filter((domain) => !allowed.includes(domain))
        if (blocked.length > 0) {
          throw new Error(`recipient domain not allowed for this connection: ${blocked[0]}`)
        }
      }

      const entry: ConsoleEmailOutboxEntry = {
        connectionId: ctx.connectionId,
        workspaceId: ctx.workspaceId,
        providerMessageId: newProviderMessageId(),
        sentAt: now(),
        input,
      }
      outbox.push(entry)
      while (outbox.length > outboxLimit) outbox.shift()

      if (options.log !== false) {
        // Headers and recipients only: bodies are message content and do
        // not belong in a log line (spec 14 §17).
        console.log(
          `[console-email] ${entry.providerMessageId} "${input.subject}" -> ${input.to
            .map((recipient) => recipient.address)
            .join(", ")}`,
        )
      }
      options.onOutboundEmail?.(entry)

      return { providerMessageId: entry.providerMessageId, status: "sent", sentAt: entry.sentAt }
    },

    get outbox(): readonly ConsoleEmailOutboxEntry[] {
      return outbox
    },

    clearOutbox(): void {
      outbox.length = 0
    },
  }
}
