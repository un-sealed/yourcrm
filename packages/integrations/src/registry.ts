import type { IntegrationCapability, IntegrationProvider } from "./provider"

/**
 * Connector registry: the list of providers this deployment knows about.
 *
 * Providers register themselves — nothing here (or anywhere else in the
 * framework) hardcodes a vendor list. An adapter module registers at import
 * time and the catalogue endpoint picks it up:
 *
 * ```ts
 * // packages/integrations/src/providers/resend.ts
 * import { registerIntegrationProvider } from "../registry"
 * registerIntegrationProvider(resendProvider)
 * ```
 *
 * The registry object satisfies `IntegrationProviderCatalogPort` in
 * `@yourcrm/crm/src/integrations` structurally, so the composition root wires
 * it straight into the domain service without an adapter.
 */

export class UnknownIntegrationProviderError extends Error {
  readonly code = "NOT_FOUND"
  constructor(readonly providerId: string) {
    super(`integration provider "${providerId}" is not registered`)
    this.name = "UnknownIntegrationProviderError"
  }
}

export class DuplicateIntegrationProviderError extends Error {
  readonly code = "CONFLICT"
  constructor(readonly providerId: string) {
    super(`integration provider "${providerId}" is already registered`)
    this.name = "DuplicateIntegrationProviderError"
  }
}

export type IntegrationProviderRegistry = {
  /** Add a provider. Throws on a duplicate id (use `replace` to overwrite). */
  register(provider: IntegrationProvider): void
  /** Add or overwrite a provider — for tests and hot reload. */
  replace(provider: IntegrationProvider): void
  unregister(providerId: string): boolean
  has(providerId: string): boolean
  /** Null when unregistered — the catalogue port shape. */
  get(providerId: string): IntegrationProvider | null
  /** Throws `UnknownIntegrationProviderError` when unregistered. */
  require(providerId: string): IntegrationProvider
  /** Every registered provider, sorted by display name. */
  list(): IntegrationProvider[]
  /** Providers declaring a capability — how downstream modules select one. */
  byCapability(capability: IntegrationCapability): IntegrationProvider[]
  clear(): void
}

export function createIntegrationProviderRegistry(
  seed: readonly IntegrationProvider[] = [],
): IntegrationProviderRegistry {
  const providers = new Map<string, IntegrationProvider>()

  const registry: IntegrationProviderRegistry = {
    register(provider) {
      if (providers.has(provider.id)) throw new DuplicateIntegrationProviderError(provider.id)
      providers.set(provider.id, provider)
    },
    replace(provider) {
      providers.set(provider.id, provider)
    },
    unregister: (providerId) => providers.delete(providerId),
    has: (providerId) => providers.has(providerId),
    get: (providerId) => providers.get(providerId) ?? null,
    require(providerId) {
      const found = providers.get(providerId)
      if (!found) throw new UnknownIntegrationProviderError(providerId)
      return found
    },
    list: () =>
      [...providers.values()].sort((a, b) =>
        a.displayName.localeCompare(b.displayName, "en", { sensitivity: "base" }),
      ),
    byCapability: (capability) =>
      registry.list().filter((provider) => provider.capabilities.includes(capability)),
    clear: () => providers.clear(),
  }

  for (const provider of seed) registry.register(provider)
  return registry
}

let defaultRegistry: IntegrationProviderRegistry | null = null

/** Process-wide registry adapter modules register into at import time. */
export function getIntegrationProviderRegistry(): IntegrationProviderRegistry {
  return (defaultRegistry ??= createIntegrationProviderRegistry())
}

/** Sugar for `getIntegrationProviderRegistry().register(provider)`. */
export function registerIntegrationProvider(provider: IntegrationProvider): void {
  getIntegrationProviderRegistry().register(provider)
}

/** Test helper: drop every provider registered in the default registry. */
export function resetIntegrationProviderRegistry(): void {
  defaultRegistry = null
}
