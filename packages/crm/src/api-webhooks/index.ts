export {
  createApiWebhooksService,
  PublicApiKeyNotFoundError,
  PublicApiKeyRoleExceedsCreatorError,
  subscribeWebhookDispatcher,
  WebhookDeliveryNotFoundError,
  WebhookSubscriptionNotFoundError,
} from "./service"
export type {
  ApiWebhooksService,
  PublicApiKeyCreated,
  WebhookDeliveryExecution,
  WebhookDispatchResult,
  WebhookSubscriptionCreated,
} from "./service"

export {
  isSubscribableEventName,
  listSubscribableEvents,
  SUBSCRIBABLE_EVENT_NAMES,
  WebhookEvents,
} from "./event-names"
export type { SubscribableEventDescriptor, WebhookEventName } from "./event-names"

export {
  assertDeliverableWebhookUrl,
  assertWebhookUrl,
  blockedAddressReason,
  checkWebhookUrl,
  createNodeDnsResolver,
  isBlockedIpAddress,
  WebhookUrlNotAllowedError,
} from "./url-guard"
export type { DeliverableWebhookTarget, WebhookDnsResolverPort, WebhookUrlCheck } from "./url-guard"

export {
  buildWebhookDeliveryHeaders,
  generateWebhookSigningSecret,
  signWebhookDelivery,
  webhookSignaturePayload,
  WEBHOOK_ATTEMPT_HEADER,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SECRET_PREFIX,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_PREFIX,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_USER_AGENT,
} from "./signing"
export type { WebhookDeliveryHeadersInput, WebhookSignatureInput } from "./signing"

export { createFetchWebhookTransport } from "./transport"

export {
  classifyWebhookResponse,
  decideWebhookRetry,
  webhookBackoffMs,
  webhookResponseSnippet,
  WEBHOOK_ATTEMPT_TIMEOUT_MS,
  WEBHOOK_AUTO_DISABLE_AFTER,
  WEBHOOK_BACKOFF_BASE_MS,
  WEBHOOK_BACKOFF_CAP_MS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RESPONSE_SNIPPET_LIMIT,
} from "./retry"
export type { WebhookAttemptOutcome, WebhookRetryDecision } from "./retry"

export {
  generatePublicApiKey,
  looksLikePublicApiKey,
  publicApiKeyLastFour,
  roleExceedsCeiling,
  PUBLIC_API_KEY_BYTES,
  PUBLIC_API_KEY_PREFIX,
} from "./api-keys"

export {
  createPublicApiKeySchema,
  createWebhookSubscriptionSchema,
  publicApiKeyCreatedSchema,
  publicApiKeyQuerySchema,
  publicApiKeyRoleSchema,
  publicApiKeySchema,
  subscribableEventSchema,
  subscribedEventNameSchema,
  subscribedEventNamesSchema,
  updateWebhookSubscriptionSchema,
  webhookDeliveryAttemptSchema,
  webhookDeliveryQuerySchema,
  webhookDeliverySchema,
  webhookDeliveryStatusSchema,
  webhookSubscriptionCreatedSchema,
  webhookSubscriptionQuerySchema,
  webhookSubscriptionSchema,
  webhookTargetUrlSchema,
} from "./schemas"
export type {
  CreatePublicApiKeyInput,
  CreateWebhookSubscriptionInput,
  PublicApiKeyCreatedDto,
  PublicApiKeyDto,
  PublicApiKeyQuery,
  PublicApiKeyRole,
  SubscribableEventDto,
  UpdateWebhookSubscriptionInput,
  WebhookDeliveryDto,
  WebhookDeliveryQuery,
  WebhookSubscriptionCreatedDto,
  WebhookSubscriptionDto,
  WebhookSubscriptionQuery,
} from "./schemas"

export type {
  ApiWebhooksAuditInput,
  ApiWebhooksServiceContext,
  ApiWebhooksServiceDeps,
  CreatePublicApiKeyStoreInput,
  CreateWebhookDeliveryStoreInput,
  CreateWebhookSubscriptionStoreInput,
  PublicApiKeyListQuery,
  PublicApiKeyListResult,
  PublicApiKeyRecord,
  PublicApiKeyStore,
  ResolvedPublicApiKey,
  WebhookDeliveryAttempt,
  WebhookDeliveryJobRequest,
  WebhookDeliveryListQuery,
  WebhookDeliveryListResult,
  WebhookDeliveryQueuePort,
  WebhookDeliveryRecord,
  WebhookDeliveryStore,
  WebhookSubscriptionListQuery,
  WebhookSubscriptionListResult,
  WebhookSubscriptionRecord,
  WebhookSubscriptionStore,
  WebhookTransportPort,
  WebhookTransportRequest,
  WebhookTransportResponse,
} from "./types"

// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
