import { z } from "zod"
import type { IntegrationProviderPort, IntegrationWebhookHandlerResult } from "./types"

/**
 * Built-in reference provider: a generic signed inbound webhook.
 *
 * Purpose is twofold.
 *  1. It is genuinely useful — Zapier / n8n / Make / a bespoke script can
 *     POST signed events into a workspace with no vendor adapter at all.
 *  2. It is the worked example every vendor adapter copies: an id, a
 *     capability list, a zod config schema, three lifecycle hooks and a
 *     webhook spec, and nothing else.
 *
 * It performs no network I/O, so it is safe to register in every
 * environment. Vendor adapters that do talk to an API belong in
 * `packages/integrations/src/providers/`.
 */

export const genericWebhookConfigSchema = z.object({
  /** Free-text note shown on the connection (what this endpoint is for). */
  note: z.string().trim().max(500).optional(),
  /** Event types to accept; empty means accept everything. */
  allowedEventTypes: z.array(z.string().trim().min(1).max(128)).max(50).default([]),
})

export const GENERIC_WEBHOOK_PROVIDER_ID = "generic-webhook"

function readStringField(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

export type GenericWebhookProviderOptions = {
  /**
   * Called for each verified, de-duplicated delivery. Defaults to "record it
   * and let `integration.webhook_received` consumers do the work".
   */
  onDelivery?: (payload: unknown, eventType: string | null) => Promise<void>
}

export function createGenericWebhookIntegrationProvider(
  options: GenericWebhookProviderOptions = {},
): IntegrationProviderPort {
  return {
    id: GENERIC_WEBHOOK_PROVIDER_ID,
    displayName: "Generic Webhook",
    description:
      "Receive HMAC-signed events from any system that can POST JSON — Zapier, n8n, Make or your own script.",
    category: "automation",
    capabilities: ["automation.webhook"],
    authKind: "api_key",
    configSchema: genericWebhookConfigSchema,
    secretLabel: "Shared token",
    webhook: {
      signatureHeader: "x-yourcrm-signature",
      algorithm: "sha256",
      encoding: "hex",
      signaturePrefix: "sha256=",
      eventIdHeader: "x-yourcrm-event-id",
      extractEventId: (payload) => readStringField(payload, "id"),
      extractEventType: (payload) => readStringField(payload, "type"),
      handle: async (delivery): Promise<IntegrationWebhookHandlerResult> => {
        const allowed = delivery.config.allowedEventTypes
        if (
          Array.isArray(allowed) &&
          allowed.length > 0 &&
          !allowed.includes(delivery.eventType ?? "")
        ) {
          return { status: "ignored", eventType: delivery.eventType, detail: "event type filtered" }
        }
        await options.onDelivery?.(delivery.payload, delivery.eventType)
        return { status: "processed", eventType: delivery.eventType }
      },
    },
    connect: async ({ secret }) => {
      if (!secret || secret.length < 16) {
        throw new Error("shared token must be at least 16 characters")
      }
      return { scopes: ["automation.webhook"] }
    },
    disconnect: async () => undefined,
    healthCheck: async ({ secret }) =>
      secret
        ? { status: "connected" }
        : { status: "error", message: "no shared token stored for this connection" },
  }
}
