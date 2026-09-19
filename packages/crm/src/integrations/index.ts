export {
  createIntegrationsService,
  IntegrationConnectFailedError,
  IntegrationConnectionNotFoundError,
  IntegrationOAuthNotSupportedError,
  IntegrationProviderNotRegisteredError,
  IntegrationWebhookHandlerError,
  IntegrationWebhookNotSupportedError,
  integrationWebhookPath,
  redactIntegrationSecrets,
} from "./service"
export type {
  IntegrationConnectionDetail,
  IntegrationsService,
  IntegrationWebhookIngestRequest,
  IntegrationWebhookIngestResult,
} from "./service"

export { IntegrationEvents } from "./event-names"
export type { IntegrationEventName } from "./event-names"

export {
  IntegrationSignatureError,
  requireIntegrationWebhookSignature,
  signIntegrationWebhookBody,
  verifyIntegrationWebhookSignature,
} from "./webhook-signature"
export type {
  IntegrationSignatureAlgorithm,
  IntegrationSignatureEncoding,
  IntegrationSignatureInput,
} from "./webhook-signature"

export {
  connectIntegrationSchema,
  integrationConnectionQuerySchema,
  integrationConnectionSchema,
  integrationConnectionStatusSchema,
  integrationCredentialKindSchema,
  integrationCredentialMetadataSchema,
  integrationProviderSummarySchema,
  integrationWebhookEventSchema,
  rotateIntegrationCredentialsSchema,
  updateIntegrationConnectionSchema,
} from "./schemas"
export type {
  ConnectIntegrationInput,
  IntegrationConnectionDto,
  IntegrationConnectionQuery,
  IntegrationCredentialMetadataDto,
  IntegrationProviderSummaryDto,
  IntegrationWebhookEventDto,
  RotateIntegrationCredentialsInput,
  UpdateIntegrationConnectionInput,
} from "./schemas"

export {
  createGenericWebhookIntegrationProvider,
  GENERIC_WEBHOOK_PROVIDER_ID,
  genericWebhookConfigSchema,
} from "./generic-webhook-provider"
export type { GenericWebhookProviderOptions } from "./generic-webhook-provider"

export { createIntegrationProviderCatalog } from "./types"
export type {
  IntegrationAuditInput,
  IntegrationAuthKindValue,
  IntegrationConfigSchemaPort,
  IntegrationConnectHookInput,
  IntegrationConnectHookResult,
  IntegrationConnectionListQuery,
  IntegrationConnectionListResult,
  IntegrationConnectionRecord,
  IntegrationConnectionStatusValue,
  IntegrationConnectionStore,
  IntegrationCredentialKindValue,
  IntegrationCredentialMetadataRecord,
  IntegrationCredentialStore,
  IntegrationHealthHookResult,
  IntegrationProviderCatalogPort,
  IntegrationProviderPort,
  IntegrationProviderRuntimeContext,
  IntegrationsServiceContext,
  IntegrationsServiceDeps,
  IntegrationWebhookDeliveryInput,
  IntegrationWebhookEventRecord,
  IntegrationWebhookHandlerResult,
  IntegrationWebhookSpecPort,
  IntegrationWebhookStore,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
