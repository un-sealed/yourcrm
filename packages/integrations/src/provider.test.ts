import { describe, expect, test } from "bun:test"
import { z } from "zod"
import {
  defineIntegrationProvider,
  InvalidIntegrationProviderError,
  isIntegrationCapability,
  isIntegrationConnectionStatus,
  isIntegrationCredentialKind,
  type IntegrationProvider,
} from "./provider"

function makeProvider(overrides: Partial<IntegrationProvider> = {}): IntegrationProvider {
  return {
    id: "acme-mail",
    displayName: "Acme Mail",
    category: "email",
    capabilities: ["email.send"],
    authKind: "api_key",
    configSchema: z.object({ fromAddress: z.string().email() }),
    connect: async () => ({ externalAccountId: "acct_1" }),
    disconnect: async () => undefined,
    healthCheck: async () => ({ status: "connected" }),
    ...overrides,
  }
}

describe("integrations/provider", () => {
  test("defineIntegrationProvider returns the definition unchanged", () => {
    const provider = makeProvider()
    expect(defineIntegrationProvider(provider)).toBe(provider)
  })

  test("a zod schema satisfies the structural config-schema contract", () => {
    const provider = defineIntegrationProvider(makeProvider())
    const parsed: unknown = provider.configSchema.parse({ fromAddress: "ada@example.com" })
    expect(parsed).toEqual({ fromAddress: "ada@example.com" })
    expect(() => provider.configSchema.parse({ fromAddress: "nope" })).toThrow()
  })

  test("rejects a malformed provider id", () => {
    expect(() => defineIntegrationProvider(makeProvider({ id: "Acme Mail" }))).toThrow(
      InvalidIntegrationProviderError,
    )
  })

  test("rejects a provider with no capabilities", () => {
    expect(() => defineIntegrationProvider(makeProvider({ capabilities: [] }))).toThrow(
      /at least one capability/,
    )
  })

  test("rejects an unknown capability", () => {
    const bogus = makeProvider({
      capabilities: ["telepathy.send"] as unknown as IntegrationProvider["capabilities"],
    })
    expect(() => defineIntegrationProvider(bogus)).toThrow(/unknown capability/)
  })

  test("value guards accept only contract members", () => {
    expect(isIntegrationCapability("email.send")).toBe(true)
    expect(isIntegrationCapability("email.teleport")).toBe(false)
    expect(isIntegrationConnectionStatus("error")).toBe(true)
    expect(isIntegrationConnectionStatus("broken")).toBe(false)
    expect(isIntegrationCredentialKind("webhook_secret")).toBe(true)
    expect(isIntegrationCredentialKind("password")).toBe(false)
  })
})
