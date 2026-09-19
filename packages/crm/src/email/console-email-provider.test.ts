import { describe, expect, test } from "bun:test"
import {
  requireIntegrationWebhookSignature,
  signIntegrationWebhookBody,
} from "../integrations/webhook-signature"
import type { IntegrationWebhookDeliveryInput } from "../integrations"
import {
  CONSOLE_EMAIL_PROVIDER_ID,
  consoleEmailConfigSchema,
  createConsoleEmailProvider,
} from "./console-email-provider"
import type { InboundEmailMessageInput } from "./schemas"
import type { EmailTransportSendInput } from "./types"

const WS = "ws_console_email"
const CONNECTION = "conn_1"
const TOKEN = "dev-token-1234567890"

function makeSendInput(overrides: Partial<EmailTransportSendInput> = {}): EmailTransportSendInput {
  return {
    messageId: "out-1@yourcrm.test",
    inReplyTo: null,
    referenceIds: [],
    subject: "Hello",
    from: { address: "sales@yourcrm.test", name: "Sales" },
    to: [{ address: "ada@example.com", name: null }],
    cc: [],
    bcc: [],
    replyTo: null,
    bodyText: "Hi there",
    bodyHtml: null,
    ...overrides,
  }
}

function makeDelivery(
  payload: unknown,
  providerEventId = "evt_1",
): IntegrationWebhookDeliveryInput {
  const rawBody = JSON.stringify(payload)
  return {
    workspaceId: WS,
    connectionId: CONNECTION,
    providerId: CONSOLE_EMAIL_PROVIDER_ID,
    config: {},
    providerEventId,
    eventType: "email.received",
    headers: {},
    rawBody,
    payload,
  }
}

function inboundPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    type: "email.received",
    message: {
      messageId: "<in-1@example.com>",
      subject: "Hello back",
      from: { address: "ada@example.com", name: "Ada" },
      to: [{ address: "sales@yourcrm.test" }],
      bodyText: "Thanks!",
      ...overrides,
    },
  }
}

describe("email/console-provider/contract", () => {
  test("declares the email provider contract the framework expects", () => {
    const provider = createConsoleEmailProvider({ log: false })
    expect(provider.id).toBe("console-email")
    expect(provider.category).toBe("email")
    expect(provider.capabilities).toEqual(["email.send", "email.receive"])
    // P0 is API-key only: OAuth is not implemented anywhere in this repo.
    expect(provider.authKind).toBe("api_key")
    expect(provider.webhook).toBeDefined()
  })

  test("the webhook spec declares WHERE the signature is, and verifies nothing itself", () => {
    const provider = createConsoleEmailProvider({ log: false })
    const spec = provider.webhook
    expect(spec?.signatureHeader).toBe("x-yourcrm-signature")
    expect(spec?.algorithm).toBe("sha256")
    expect(spec?.signaturePrefix).toBe("sha256=")
    // The framework owns verification; this provider exposes no verifier.
    expect(Object.keys(provider)).not.toContain("verifySignature")
  })

  test("the framework's verifier accepts a body signed with the declared spec", () => {
    const provider = createConsoleEmailProvider({ log: false })
    const spec = provider.webhook
    const rawBody = JSON.stringify(inboundPayload())
    const signature = signIntegrationWebhookBody({
      secret: "webhook-secret-value",
      rawBody,
      algorithm: spec?.algorithm ?? "sha256",
      encoding: spec?.encoding,
      prefix: spec?.signaturePrefix,
    })
    expect(() =>
      requireIntegrationWebhookSignature({
        secret: "webhook-secret-value",
        rawBody,
        algorithm: spec?.algorithm ?? "sha256",
        encoding: spec?.encoding,
        prefix: spec?.signaturePrefix,
        signature,
      }),
    ).not.toThrow()
  })

  test("event id and type are extracted from the payload", () => {
    const provider = createConsoleEmailProvider({ log: false })
    const payload = inboundPayload()
    expect(provider.webhook?.extractEventId?.(payload, {})).toBe("evt_1")
    expect(provider.webhook?.extractEventType?.(payload, {})).toBe("email.received")
    expect(provider.webhook?.extractEventId?.("not json", {})).toBeNull()
  })

  test("connect verifies the token shape without any network call", async () => {
    const provider = createConsoleEmailProvider({ log: false })
    const config = { fromAddress: "sales@yourcrm.test" }
    const result = await provider.connect({
      workspaceId: WS,
      connectionId: CONNECTION,
      displayName: "Dev mailbox",
      config,
      secret: TOKEN,
    })
    expect(result.externalAccountId).toBe("sales@yourcrm.test")
    await expect(
      provider.connect({
        workspaceId: WS,
        connectionId: CONNECTION,
        displayName: "Dev mailbox",
        config,
        secret: "short",
      }),
    ).rejects.toThrow()
  })

  test("healthCheck reports connected only when a token is stored", async () => {
    const provider = createConsoleEmailProvider({ log: false })
    const ctx = { workspaceId: WS, connectionId: CONNECTION, config: {} }
    expect((await provider.healthCheck({ ...ctx, secret: TOKEN })).status).toBe("connected")
    expect((await provider.healthCheck({ ...ctx, secret: null })).status).toBe("error")
  })

  test("the config schema requires a from address", () => {
    expect(() => consoleEmailConfigSchema.parse({})).toThrow()
    expect(consoleEmailConfigSchema.parse({ fromAddress: "Sales@YourCRM.test" }).fromAddress).toBe(
      "sales@yourcrm.test",
    )
  })
})

describe("email/console-provider/send", () => {
  test("captures the send and returns a provider message id", async () => {
    const provider = createConsoleEmailProvider({ log: false })
    const result = await provider.sendEmail(makeSendInput(), {
      workspaceId: WS,
      connectionId: CONNECTION,
      config: {},
      secret: TOKEN,
    })
    expect(result.status).toBe("sent")
    expect(result.providerMessageId).toMatch(/^console-/)
    expect(provider.outbox).toHaveLength(1)
    provider.clearOutbox()
    expect(provider.outbox).toHaveLength(0)
  })

  test("refuses to send without a stored token", async () => {
    const provider = createConsoleEmailProvider({ log: false })
    await expect(
      provider.sendEmail(makeSendInput(), {
        workspaceId: WS,
        connectionId: CONNECTION,
        config: {},
        secret: null,
      }),
    ).rejects.toThrow()
  })

  test("allowedRecipientDomains keeps a dev mailbox off real inboxes", async () => {
    const provider = createConsoleEmailProvider({ log: false })
    const ctx = {
      workspaceId: WS,
      connectionId: CONNECTION,
      config: { allowedRecipientDomains: ["example.com"] },
      secret: TOKEN,
    }
    await expect(provider.sendEmail(makeSendInput(), ctx)).resolves.toBeDefined()
    await expect(
      provider.sendEmail(makeSendInput({ to: [{ address: "ceo@real-customer.com" }] }), ctx),
    ).rejects.toThrow(/not allowed/)
  })

  test("the outbox is bounded so a long-running dev process cannot grow forever", async () => {
    const provider = createConsoleEmailProvider({ log: false, outboxLimit: 2 })
    for (let i = 0; i < 5; i += 1) {
      await provider.sendEmail(makeSendInput({ subject: `n${i}` }), {
        workspaceId: WS,
        connectionId: CONNECTION,
        config: {},
        secret: TOKEN,
      })
    }
    expect(provider.outbox).toHaveLength(2)
    expect(provider.outbox[1]?.input.subject).toBe("n4")
  })
})

describe("email/console-provider/webhook", () => {
  test("a verified delivery is handed on as a structured inbound message", async () => {
    const seen: InboundEmailMessageInput[] = []
    const provider = createConsoleEmailProvider({
      log: false,
      onInboundEmail: async (input) => void seen.push(input),
    })
    const outcome = await provider.webhook?.handle(makeDelivery(inboundPayload()))
    expect(outcome?.status).toBe("processed")
    expect(seen).toHaveLength(1)
    expect(seen[0]?.workspaceId).toBe(WS)
    expect(seen[0]?.connectionId).toBe(CONNECTION)
    expect(seen[0]?.messageId).toBe("<in-1@example.com>")
    expect(seen[0]?.from.address).toBe("ada@example.com")
  })

  test("a payload without a Message-ID gets one derived from the provider event id", async () => {
    const seen: InboundEmailMessageInput[] = []
    const provider = createConsoleEmailProvider({
      log: false,
      onInboundEmail: async (input) => void seen.push(input),
    })
    const payload = inboundPayload({ messageId: null })
    await provider.webhook?.handle(makeDelivery(payload, "evt_77"))
    await provider.webhook?.handle(makeDelivery(payload, "evt_77"))
    // Same derived id both times: a retry de-duplicates downstream.
    expect(seen.map((input) => input.messageId)).toEqual([
      "evt_77@console-email.invalid",
      "evt_77@console-email.invalid",
    ])
  })

  test("a non-email payload is ignored rather than failed (no retry storm)", async () => {
    const provider = createConsoleEmailProvider({ log: false })
    const ping = await provider.webhook?.handle(makeDelivery({ id: "evt_2", type: "ping" }))
    expect(ping?.status).toBe("ignored")
    const junk = await provider.webhook?.handle(makeDelivery({ hello: "world" }))
    expect(junk?.status).toBe("ignored")
  })

  test("an unsupported event type is ignored", async () => {
    const provider = createConsoleEmailProvider({ log: false })
    const payload = { ...inboundPayload(), type: "email.bounced" }
    const outcome = await provider.webhook?.handle(makeDelivery(payload))
    expect(outcome?.status).toBe("ignored")
    expect(outcome?.eventType).toBe("email.bounced")
  })

  test("handle performs no writes of its own — it only forwards", async () => {
    // No `onInboundEmail` wired: the handler must still succeed and must not
    // throw, so a deployment that has not wired the service yet degrades to
    // "delivery recorded, nothing stored" instead of a 500 retry loop.
    const provider = createConsoleEmailProvider({ log: false })
    const outcome = await provider.webhook?.handle(makeDelivery(inboundPayload()))
    expect(outcome?.status).toBe("processed")
  })
})
