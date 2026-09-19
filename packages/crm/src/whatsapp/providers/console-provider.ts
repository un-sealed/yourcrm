import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { IntegrationProviderPort, IntegrationWebhookHandlerResult } from "../../integrations"
import type {
  WhatsAppInboundMessageInput,
  WhatsAppInboundStatusInput,
  WhatsAppProviderAdapter,
  WhatsAppSendResult,
  WhatsAppSendTemplateInput,
  WhatsAppSendTextInput,
} from "../types"

/**
 * Dev/console WhatsApp provider (spec 16-whatsapp, P0 — "the module must be
 * fully testable with no real credentials").
 *
 * Does no network I/O. Outbound sends are logged (default `console.log`,
 * injectable for tests) and return a synthesised `providerMessageId`.
 * Inbound is driven by POSTing a synthetic, HMAC-signed event to the shared
 * webhook endpoint (`POST /api/v1/integrations/:connectionId/webhook`,
 * owned by the integrations module) — sign it with
 * `signIntegrationWebhookBody` from `@yourcrm/crm/src/integrations`, exactly
 * like `generic-webhook-provider.ts`'s worked example.
 *
 * This is the worked example for a REAL vendor adapter (Meta WhatsApp Cloud
 * API): same id/capabilities/configSchema/webhook shape, with `sendText` /
 * `sendTemplate` calling the real Graph API instead of `console.log`, and
 * `connect`/`healthCheck` calling Meta instead of a length check.
 *
 * WIRING GAP (integrator, matches the documented pattern in
 * `packages/integrations/README.md`'s OAuth note and
 * `apps/api/src/routes/modules/integrations.ts`'s `defaultIntegrationProviders()`
 * comment): that function is not owned by this module and still returns a
 * static provider list. Registering this provider there —
 * `createWhatsAppConsoleProvider({ onInboundMessage: (i) => whatsapp.ingestInboundMessage(i),
 * onStatusUpdate: (i) => whatsapp.ingestStatusUpdate(i) })` — is what makes
 * inbound WhatsApp webhooks reach this module's domain service. Until then,
 * the provider is fully unit-tested in isolation (`console-provider.test.ts`)
 * but not reachable from a live HTTP request.
 */

export const WHATSAPP_CONSOLE_PROVIDER_ID = "whatsapp-console"

export const consoleWhatsAppConfigSchema = z.object({
  /** Cosmetic only — the "From" number shown in the console log line. */
  fromPhone: z.string().trim().max(32).optional(),
})

function readStringField(payload: unknown, key: string): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function readObjectField(payload: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof payload !== "object" || payload === null) return undefined
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

/** WhatsApp Cloud API timestamps are seconds-since-epoch strings; accept both that and ISO. */
function parseOccurredAt(value: unknown): Date {
  if (typeof value === "string" && /^\d+$/.test(value)) return new Date(Number(value) * 1000)
  if (typeof value === "number") return new Date(value * 1000)
  if (typeof value === "string") {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return new Date()
}

const INBOUND_MEDIA_KINDS = new Set(["image", "document", "audio", "video", "interactive"])

export type ConsoleWhatsAppProviderOptions = {
  /** Wire this to `whatsappService.ingestInboundMessage` to actually persist inbound messages. */
  onInboundMessage?: (input: WhatsAppInboundMessageInput) => Promise<void>
  /** Wire this to `whatsappService.ingestStatusUpdate`. */
  onStatusUpdate?: (input: WhatsAppInboundStatusInput) => Promise<void>
  /** Sink for the "sent" log line. Defaults to `console.log`; tests inject a spy. */
  log?: (line: string) => void
}

export function createWhatsAppConsoleProvider(
  options: ConsoleWhatsAppProviderOptions = {},
): IntegrationProviderPort & WhatsAppProviderAdapter {
  const log = options.log ?? ((line: string) => console.log(line))

  async function sendText(input: WhatsAppSendTextInput): Promise<WhatsAppSendResult> {
    if (!input.secret || input.secret.trim().length === 0) {
      throw new Error("whatsapp-console: missing dev API key")
    }
    const providerMessageId = `console_${randomUUID()}`
    log(`[whatsapp-console] -> ${input.to}: ${input.body} (${providerMessageId})`)
    return { providerMessageId }
  }

  async function sendTemplate(input: WhatsAppSendTemplateInput): Promise<WhatsAppSendResult> {
    if (!input.secret || input.secret.trim().length === 0) {
      throw new Error("whatsapp-console: missing dev API key")
    }
    const providerMessageId = `console_${randomUUID()}`
    log(
      `[whatsapp-console] -> ${input.to}: template "${input.templateName}" (${input.language}) ${JSON.stringify(input.variables)} (${providerMessageId})`,
    )
    return { providerMessageId }
  }

  return {
    id: WHATSAPP_CONSOLE_PROVIDER_ID,
    displayName: "WhatsApp (Console/Dev)",
    description:
      "Development/test WhatsApp provider: logs outbound sends instead of calling Meta, and accepts synthetic signed webhooks for inbound messages and status updates. No real credentials or network calls.",
    category: "messaging",
    capabilities: ["messaging.send", "messaging.receive"],
    authKind: "api_key",
    configSchema: consoleWhatsAppConfigSchema,
    secretLabel: "Dev API key (any non-empty value)",
    webhook: {
      signatureHeader: "x-whatsapp-console-signature",
      algorithm: "sha256",
      encoding: "hex",
      signaturePrefix: "sha256=",
      extractEventId: (payload) => readStringField(payload, "id") ?? null,
      extractEventType: (payload) => readStringField(payload, "type") ?? null,
      handle: async (delivery): Promise<IntegrationWebhookHandlerResult> => {
        const type = readStringField(delivery.payload, "type")

        if (type === "message") {
          const message = readObjectField(delivery.payload, "message")
          const from = message ? readStringField(message, "from") : undefined
          const messageId = message ? readStringField(message, "id") : undefined
          if (!message || !from || !messageId) {
            return { status: "ignored", eventType: "message", detail: "malformed message payload" }
          }
          const text = readObjectField(message, "text")
          const media = readObjectField(message, "media")
          const mediaKind = media ? readStringField(media, "kind") : undefined
          await options.onInboundMessage?.({
            workspaceId: delivery.workspaceId,
            connectionId: delivery.connectionId,
            from,
            providerMessageId: messageId,
            text: text ? (readStringField(text, "body") ?? null) : null,
            media:
              media && mediaKind && INBOUND_MEDIA_KINDS.has(mediaKind)
                ? {
                    kind: mediaKind,
                    storageKey: readStringField(media, "storageKey") ?? null,
                    contentType: readStringField(media, "contentType") ?? null,
                    fileName: readStringField(media, "fileName") ?? null,
                    sizeBytes:
                      typeof media.sizeBytes === "number" ? (media.sizeBytes as number) : null,
                  }
                : null,
            occurredAt: parseOccurredAt(message.timestamp),
            correlationId: delivery.providerEventId,
          })
          return { status: "processed", eventType: "message" }
        }

        if (type === "status") {
          const status = readObjectField(delivery.payload, "status")
          const providerMessageId = status ? readStringField(status, "id") : undefined
          const statusValue = status ? readStringField(status, "status") : undefined
          if (!status || !providerMessageId || !statusValue) {
            return { status: "ignored", eventType: "status", detail: "malformed status payload" }
          }
          await options.onStatusUpdate?.({
            workspaceId: delivery.workspaceId,
            providerMessageId,
            status: statusValue,
            error: readStringField(status, "error") ?? null,
            occurredAt: parseOccurredAt(status.timestamp),
            correlationId: delivery.providerEventId,
          })
          return { status: "processed", eventType: "status" }
        }

        return {
          status: "ignored",
          eventType: type ?? null,
          detail: "unrecognised whatsapp-console event",
        }
      },
    },
    connect: async ({ secret }) => {
      if (!secret || secret.trim().length < 8) {
        throw new Error("dev API key must be at least 8 characters")
      }
      return { scopes: ["messaging.send", "messaging.receive"] }
    },
    disconnect: async () => undefined,
    healthCheck: async ({ secret }) =>
      secret
        ? { status: "connected" }
        : { status: "error", message: "no dev API key stored for this connection" },
    sendText,
    sendTemplate,
  }
}
