/**
 * `@yourcrm/integrations` — the connector framework's provider SDK.
 *
 * This package answers one question: *what is a provider?* It owns the typed
 * `IntegrationProvider` contract and the registry providers register into.
 * Vendor adapters (Resend/SES, Meta WhatsApp, Twilio/Exotel, Google Calendar,
 * …) land in `src/providers/*.ts`, each built with
 * {@link defineIntegrationProvider} and registered via
 * {@link registerIntegrationProvider}. Nothing hardcodes a vendor list.
 *
 * WHERE THE REST OF THE FRAMEWORK LIVES
 * -------------------------------------
 * The runtime around this contract is split by what each layer can reach in
 * the workspace dependency graph (see the blocker note below):
 *
 * - connection lifecycle, permissions, events, audit, webhook signature
 *   verification and idempotency  -> `packages/crm/src/integrations/`
 * - tables + AES-256-GCM credential encryption at rest
 *   -> `packages/database/src/{schema,repositories}/integrations*`
 * - HTTP surface (admin routes + the public webhook endpoint)
 *   -> `apps/api/src/routes/modules/integrations.ts`
 *
 * BLOCKER (integrator): neither `@yourcrm/crm` nor `apps/api` declares
 * `@yourcrm/integrations`, so bun does not symlink it into their
 * `node_modules` and `import "@yourcrm/integrations"` does not resolve from
 * either. Until that dependency is declared, `packages/crm/src/integrations/
 * types.ts` carries a structural mirror of the contract below
 * (`IntegrationProviderPort`) and the API route ships an empty provider
 * catalogue. Wiring the dependency turns both into one-line changes — see
 * that file's header.
 */

export {
  defineIntegrationProvider,
  INTEGRATION_AUTH_KINDS,
  INTEGRATION_CAPABILITIES,
  INTEGRATION_CATEGORIES,
  INTEGRATION_CONNECTION_STATUSES,
  INTEGRATION_CREDENTIAL_KINDS,
  InvalidIntegrationProviderError,
  isIntegrationCapability,
  isIntegrationConnectionStatus,
  isIntegrationCredentialKind,
} from "./provider"
export type {
  IntegrationAuthKind,
  IntegrationCapability,
  IntegrationCategory,
  IntegrationConfigSchema,
  IntegrationConnectInput,
  IntegrationConnectionStatus,
  IntegrationConnectResult,
  IntegrationCredentialKind,
  IntegrationHealthResult,
  IntegrationProvider,
  IntegrationProviderContext,
  IntegrationWebhookDelivery,
  IntegrationWebhookOutcome,
  IntegrationWebhookSpec,
} from "./provider"

export {
  createIntegrationProviderRegistry,
  DuplicateIntegrationProviderError,
  getIntegrationProviderRegistry,
  registerIntegrationProvider,
  resetIntegrationProviderRegistry,
  UnknownIntegrationProviderError,
} from "./registry"
export type { IntegrationProviderRegistry } from "./registry"

/**
 * Bumped from 0 (placeholder) to 1: the provider contract and registry are
 * real. Downstream adapters can pin against this.
 */
export const INTEGRATIONS_BOUNDARY_VERSION = 1 as const
