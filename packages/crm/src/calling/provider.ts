import { randomUUID } from "node:crypto"
import { z } from "zod"
import { defineIntegrationProvider } from "@yourcrm/integrations"
import type { IntegrationWebhookOutcome } from "@yourcrm/integrations"
import { isCallStatus, type CallStatus } from "./status"
import type { CallingProviderCatalogPort, CallingProviderPort } from "./types"

/**
 * Built-in reference provider: a simulated "console" calling adapter.
 *
 * Required by spec 17-calling P0 ("a dev/console provider so the module is
 * fully testable with no real credentials") and the worked example for a
 * real vendor adapter (Twilio/Exotel/Plivo/…) landing later in
 * `packages/integrations/src/providers/`: an id, a capability list, a zod
 * config schema, the three `IntegrationProvider` lifecycle hooks, a webhook
 * spec for inbound status callbacks, and — the calling-specific extension —
 * `placeCall`.
 *
 * It performs no network I/O: `placeCall` mints a fake provider call id and
 * returns `ringing` immediately, exactly like a real provider's synchronous
 * "call accepted" response. Status then advances the same way a real
 * provider's webhook would, via `webhook.handle`.
 */

export const CONSOLE_CALLING_PROVIDER_ID = "console-calling"

export const consoleCallingConfigSchema = z.object({
  /** Default outbound caller id used when a click-to-call request omits one. */
  callerId: z.string().trim().max(32).optional(),
})

function readStringField(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

function readNumberField(payload: unknown, key: string): number | null {
  if (typeof payload !== "object" || payload === null) return null
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** What the console provider's webhook payload carries. */
export type ConsoleCallStatusEvent = {
  /** From the verified delivery, not the payload — never trust a client-supplied workspace/provider id. */
  workspaceId: string
  providerId: string
  providerCallId: string
  status: CallStatus
  occurredAt: Date
  durationSeconds?: number | null
  errorMessage?: string | null
}

export type ConsoleCallingProviderOptions = {
  /**
   * Called for each verified, de-duplicated status delivery — the API layer
   * wires this to the calling service's `applyProviderStatusEvent`, since
   * `@yourcrm/crm` cannot reach the database itself.
   */
  onStatusEvent?: (event: ConsoleCallStatusEvent) => Promise<void>
}

export function createConsoleCallingProvider(
  options: ConsoleCallingProviderOptions = {},
): CallingProviderPort {
  const provider: CallingProviderPort = {
    id: CONSOLE_CALLING_PROVIDER_ID,
    displayName: "Console (Dev/Test)",
    description:
      "Simulated calling provider for local development and tests. Places no real call: mints a fake call id and lets you simulate status webhooks via the signed webhook endpoint.",
    category: "calling",
    capabilities: ["calling.place", "calling.receive"],
    authKind: "api_key",
    configSchema: consoleCallingConfigSchema,
    secretLabel: "Dev token",
    webhook: {
      signatureHeader: "x-yourcrm-calling-signature",
      algorithm: "sha256",
      encoding: "hex",
      signaturePrefix: "sha256=",
      eventIdHeader: "x-yourcrm-calling-event-id",
      extractEventId: (payload) => readStringField(payload, "id"),
      extractEventType: () => "call.status",
      handle: async (delivery): Promise<IntegrationWebhookOutcome> => {
        const providerCallId = readStringField(delivery.payload, "callId")
        const status = readStringField(delivery.payload, "status")
        if (!providerCallId || !status || !isCallStatus(status)) {
          return { status: "ignored", detail: "payload missing callId/status" }
        }
        const occurredAtRaw = readStringField(delivery.payload, "occurredAt")
        const occurredAt = occurredAtRaw ? new Date(occurredAtRaw) : new Date()
        await options.onStatusEvent?.({
          workspaceId: delivery.workspaceId,
          providerId: delivery.providerId,
          providerCallId,
          status,
          occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
          durationSeconds: readNumberField(delivery.payload, "durationSeconds"),
          errorMessage: readStringField(delivery.payload, "error"),
        })
        return { status: "processed", eventType: "call.status" }
      },
    },
    connect: async ({ secret }) => {
      if (!secret || secret.length < 8) {
        throw new Error("dev token must be at least 8 characters")
      }
      return { scopes: ["calling.place", "calling.receive"] }
    },
    disconnect: async () => undefined,
    healthCheck: async ({ secret }) =>
      secret
        ? { status: "connected" }
        : { status: "error", message: "no dev token stored for this connection" },
    placeCall: async (_ctx, _input) => ({
      providerCallId: `console_${randomUUID()}`,
      status: "ringing",
    }),
  }
  // Validates the id format and capability list; throws on a malformed
  // provider at construction time rather than on first use. The return
  // value (typed as the base `IntegrationProvider`) is discarded — we keep
  // the original reference so `placeCall` stays in the returned type.
  defineIntegrationProvider(provider)
  return provider
}

/** Wrap a fixed calling-provider list as a catalogue (tests, static wiring). */
export function createCallingProviderCatalog(
  providers: readonly CallingProviderPort[],
): CallingProviderCatalogPort {
  const byId = new Map(providers.map((provider) => [provider.id, provider]))
  return {
    get: (providerId) => byId.get(providerId) ?? null,
    list: () =>
      [...byId.values()].sort((a, b) =>
        a.displayName.localeCompare(b.displayName, "en", { sensitivity: "base" }),
      ),
  }
}
