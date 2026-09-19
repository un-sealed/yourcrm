import { beforeEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import { defineIntegrationProvider, type IntegrationProvider } from "./provider"
import {
  createIntegrationProviderRegistry,
  DuplicateIntegrationProviderError,
  getIntegrationProviderRegistry,
  registerIntegrationProvider,
  resetIntegrationProviderRegistry,
  UnknownIntegrationProviderError,
} from "./registry"

function makeProvider(id: string, overrides: Partial<IntegrationProvider> = {}) {
  return defineIntegrationProvider({
    id,
    displayName: id.toUpperCase(),
    category: "email",
    capabilities: ["email.send"],
    authKind: "api_key",
    configSchema: z.object({}),
    connect: async () => ({}),
    disconnect: async () => undefined,
    healthCheck: async () => ({ status: "connected" }),
    ...overrides,
  })
}

describe("integrations/registry", () => {
  beforeEach(() => {
    resetIntegrationProviderRegistry()
  })

  test("providers register themselves; nothing hardcodes a vendor list", () => {
    const registry = createIntegrationProviderRegistry()
    expect(registry.list()).toEqual([])
    registry.register(makeProvider("zulu"))
    registry.register(makeProvider("alpha"))
    expect(registry.list().map((p) => p.id)).toEqual(["alpha", "zulu"])
  })

  test("duplicate ids are rejected, replace overwrites", () => {
    const registry = createIntegrationProviderRegistry([makeProvider("acme")])
    expect(() => registry.register(makeProvider("acme"))).toThrow(DuplicateIntegrationProviderError)
    registry.replace(makeProvider("acme", { displayName: "Acme v2" }))
    expect(registry.require("acme").displayName).toBe("Acme v2")
  })

  test("require throws for an unregistered id, get returns null", () => {
    const registry = createIntegrationProviderRegistry()
    expect(registry.get("nope")).toBeNull()
    expect(() => registry.require("nope")).toThrow(UnknownIntegrationProviderError)
  })

  test("byCapability is how downstream modules select a provider", () => {
    const registry = createIntegrationProviderRegistry([
      makeProvider("mailer", { capabilities: ["email.send", "email.receive"] }),
      makeProvider("dialer", { category: "calling", capabilities: ["calling.place"] }),
    ])
    expect(registry.byCapability("email.receive").map((p) => p.id)).toEqual(["mailer"])
    expect(registry.byCapability("calling.place").map((p) => p.id)).toEqual(["dialer"])
    expect(registry.byCapability("payments")).toEqual([])
  })

  test("the default registry is a process singleton adapters register into", () => {
    registerIntegrationProvider(makeProvider("selfreg"))
    expect(getIntegrationProviderRegistry().has("selfreg")).toBe(true)
    resetIntegrationProviderRegistry()
    expect(getIntegrationProviderRegistry().has("selfreg")).toBe(false)
  })

  test("unregister and clear drop providers", () => {
    const registry = createIntegrationProviderRegistry([makeProvider("aa"), makeProvider("bb")])
    expect(registry.unregister("aa")).toBe(true)
    expect(registry.unregister("aa")).toBe(false)
    registry.clear()
    expect(registry.list()).toEqual([])
  })
})
