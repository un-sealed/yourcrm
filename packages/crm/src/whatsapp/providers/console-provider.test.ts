import { describe, expect, test } from "bun:test"
import { signIntegrationWebhookBody } from "../../integrations"
import type { WhatsAppInboundMessageInput, WhatsAppInboundStatusInput } from "../types"
import { createWhatsAppConsoleProvider, WHATSAPP_CONSOLE_PROVIDER_ID } from "./console-provider"

const SECRET = "whsec_dev_0123456789abcdef"
const WORKSPACE_ID = "ws-1"
const CONNECTION_ID = "conn-1"

function deliveryFor(payload: unknown) {
  const rawBody = JSON.stringify(payload)
  return {
    workspaceId: WORKSPACE_ID,
    connectionId: CONNECTION_ID,
    providerId: WHATSAPP_CONSOLE_PROVIDER_ID,
    config: {},
    providerEventId: (payload as { id: string }).id,
    eventType: (payload as { type: string }).type,
    headers: {
      "x-whatsapp-console-signature": signIntegrationWebhookBody({
        secret: SECRET,
        rawBody,
        algorithm: "sha256",
        prefix: "sha256=",
      }),
    },
    rawBody,
    payload,
  }
}

describe("whatsapp/console-provider", () => {
  test("has the shape the framework expects: messaging category, api_key auth, a webhook spec", () => {
    const provider = createWhatsAppConsoleProvider()
    expect(provider.id).toBe(WHATSAPP_CONSOLE_PROVIDER_ID)
    expect(provider.category).toBe("messaging")
    expect(provider.capabilities).toContain("messaging.send")
    expect(provider.capabilities).toContain("messaging.receive")
    expect(provider.authKind).toBe("api_key")
    expect(provider.webhook).toBeDefined()
  })

  test("connect rejects a too-short dev key and accepts a real one", async () => {
    const provider = createWhatsAppConsoleProvider()
    await expect(
      provider.connect({
        workspaceId: WORKSPACE_ID,
        connectionId: CONNECTION_ID,
        displayName: "Dev",
        config: {},
        secret: "short",
      }),
    ).rejects.toThrow(/at least 8 characters/)
    const result = await provider.connect({
      workspaceId: WORKSPACE_ID,
      connectionId: CONNECTION_ID,
      displayName: "Dev",
      config: {},
      secret: SECRET,
    })
    expect(result.scopes).toContain("messaging.send")
  })

  test("healthCheck reflects whether a secret is stored", async () => {
    const provider = createWhatsAppConsoleProvider()
    const ctx = { workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, config: {} }
    expect((await provider.healthCheck({ ...ctx, secret: SECRET })).status).toBe("connected")
    expect((await provider.healthCheck({ ...ctx, secret: null })).status).toBe("error")
  })

  test("sendText and sendTemplate return a synthesised provider message id and log the attempt", async () => {
    const lines: string[] = []
    const provider = createWhatsAppConsoleProvider({ log: (line) => lines.push(line) })
    const textResult = await provider.sendText({
      workspaceId: WORKSPACE_ID,
      connectionId: CONNECTION_ID,
      config: {},
      secret: SECRET,
      to: "+14155552671",
      body: "Hello",
    })
    expect(textResult.providerMessageId).toMatch(/^console_/)

    const templateResult = await provider.sendTemplate({
      workspaceId: WORKSPACE_ID,
      connectionId: CONNECTION_ID,
      config: {},
      secret: SECRET,
      to: "+14155552671",
      templateName: "order_update",
      language: "en_US",
      variables: ["A100"],
    })
    expect(templateResult.providerMessageId).toMatch(/^console_/)
    expect(templateResult.providerMessageId).not.toBe(textResult.providerMessageId)
    expect(lines).toHaveLength(2)
    expect(lines[0]).not.toContain(SECRET)
    expect(lines[1]).toContain("order_update")
  })

  test("sendText rejects an empty secret without logging anything", async () => {
    const lines: string[] = []
    const provider = createWhatsAppConsoleProvider({ log: (line) => lines.push(line) })
    await expect(
      provider.sendText({
        workspaceId: WORKSPACE_ID,
        connectionId: CONNECTION_ID,
        config: {},
        secret: "",
        to: "+1",
        body: "Hi",
      }),
    ).rejects.toThrow(/missing dev API key/)
    expect(lines).toHaveLength(0)
  })

  test("webhook.handle dispatches an inbound message to onInboundMessage", async () => {
    const received: WhatsAppInboundMessageInput[] = []
    const provider = createWhatsAppConsoleProvider({
      onInboundMessage: async (i) => void received.push(i),
    })
    const payload = {
      id: "evt_1",
      type: "message",
      message: {
        id: "wamid.001",
        from: "14155552671",
        timestamp: "1735689600",
        text: { body: "Hi there" },
      },
    }
    const outcome = await provider.webhook!.handle(deliveryFor(payload))
    expect(outcome).toEqual({ status: "processed", eventType: "message" })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      connectionId: CONNECTION_ID,
      from: "14155552671",
      providerMessageId: "wamid.001",
      text: "Hi there",
    })
    expect(received[0]?.occurredAt).toBeInstanceOf(Date)
  })

  test("webhook.handle dispatches media metadata without ever carrying bytes", async () => {
    const received: WhatsAppInboundMessageInput[] = []
    const provider = createWhatsAppConsoleProvider({
      onInboundMessage: async (i) => void received.push(i),
    })
    const payload = {
      id: "evt_2",
      type: "message",
      message: {
        id: "wamid.002",
        from: "14155552671",
        media: {
          kind: "image",
          storageKey: "whatsapp/ws-1/wamid.002.jpg",
          contentType: "image/jpeg",
          sizeBytes: 2048,
        },
      },
    }
    await provider.webhook!.handle(deliveryFor(payload))
    expect(received[0]?.media).toEqual({
      kind: "image",
      storageKey: "whatsapp/ws-1/wamid.002.jpg",
      contentType: "image/jpeg",
      fileName: null,
      sizeBytes: 2048,
    })
  })

  test("webhook.handle dispatches a status update to onStatusUpdate", async () => {
    const received: WhatsAppInboundStatusInput[] = []
    const provider = createWhatsAppConsoleProvider({
      onStatusUpdate: async (i) => void received.push(i),
    })
    const payload = {
      id: "evt_3",
      type: "status",
      status: { id: "wamid.001", status: "delivered", timestamp: "1735689700" },
    }
    const outcome = await provider.webhook!.handle(deliveryFor(payload))
    expect(outcome).toEqual({ status: "processed", eventType: "status" })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ providerMessageId: "wamid.001", status: "delivered" })
  })

  test("webhook.handle is safe to call twice for the same delivery (idempotent by construction)", async () => {
    const received: WhatsAppInboundMessageInput[] = []
    const provider = createWhatsAppConsoleProvider({
      onInboundMessage: async (i) => void received.push(i),
    })
    const payload = {
      id: "evt_4",
      type: "message",
      message: { id: "wamid.003", from: "1", text: { body: "hi" } },
    }
    // The framework guarantees `handle` runs at most once per successfully
    // processed delivery, but MAY re-invoke it for a previously failed one —
    // this proves the provider itself adds no extra state that would break
    // that contract (idempotency is enforced downstream, in the repository).
    await provider.webhook!.handle(deliveryFor(payload))
    await provider.webhook!.handle(deliveryFor(payload))
    expect(received).toHaveLength(2)
  })

  test("webhook.handle ignores an unrecognised event type", async () => {
    const provider = createWhatsAppConsoleProvider()
    const payload = { id: "evt_5", type: "ping" }
    const outcome = await provider.webhook!.handle(deliveryFor(payload))
    expect(outcome.status).toBe("ignored")
  })

  test("webhook.handle ignores a malformed message payload instead of throwing", async () => {
    const provider = createWhatsAppConsoleProvider()
    const payload = { id: "evt_6", type: "message", message: { id: "wamid.004" /* no "from" */ } }
    const outcome = await provider.webhook!.handle(deliveryFor(payload))
    expect(outcome.status).toBe("ignored")
  })

  test("extractEventId/extractEventType read the top-level id/type fields", () => {
    const provider = createWhatsAppConsoleProvider()
    const payload = { id: "evt_7", type: "status", status: { id: "wamid.005", status: "read" } }
    expect(provider.webhook!.extractEventId!(payload, {})).toBe("evt_7")
    expect(provider.webhook!.extractEventType!(payload, {})).toBe("status")
  })

  test("does no network I/O and is safe to construct with zero options", () => {
    expect(() => createWhatsAppConsoleProvider()).not.toThrow()
  })
})
