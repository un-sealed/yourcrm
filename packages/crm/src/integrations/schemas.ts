import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"

/**
 * Integrations zod schemas. Services validate inputs with these; API routes
 * reuse them at the HTTP boundary via `@hono/zod-validator`.
 *
 * SECRETS: `apiKey` / `webhookSecret` appear only in REQUEST schemas. No
 * response schema in this file has a field that can hold a secret — the
 * strongest form of "never return credentials" is having nowhere to put one.
 */

const providerIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{1,62}$/, "providerId must be lower-kebab/snake case")

export const integrationConnectionStatusSchema = z.enum(["connected", "disconnected", "error"])

export const integrationCredentialKindSchema = z.enum(["api_key", "webhook_secret", "oauth_tokens"])

export const integrationConnectionQuerySchema = paginationQuerySchema.extend({
  providerId: providerIdSchema.optional(),
  status: integrationConnectionStatusSchema.optional(),
})

export type IntegrationConnectionQuery = z.infer<typeof integrationConnectionQuerySchema>

/**
 * Connect an API-key integration.
 *
 * `webhookSecret` is the secret the PROVIDER issued (Meta app secret, Stripe
 * `whsec_…`, an n8n shared secret): the admin pastes it here and inbound
 * deliveries are verified against it. The framework never generates one,
 * because it could never show it to anyone afterwards — credentials are
 * write-only by contract.
 */
export const connectIntegrationSchema = z.object({
  providerId: providerIdSchema,
  displayName: z.string().trim().min(1).max(255),
  /** Non-secret provider settings; re-validated by the provider's schema. */
  config: z.record(z.unknown()).default({}),
  apiKey: z.string().min(8).max(4096),
  webhookSecret: z.string().min(16).max(512).optional(),
  scopes: z.array(z.string().trim().min(1).max(128)).max(50).default([]),
})

export type ConnectIntegrationInput = z.infer<typeof connectIntegrationSchema>

export const updateIntegrationConnectionSchema = z
  .object({
    displayName: z.string().trim().min(1).max(255),
    config: z.record(z.unknown()),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateIntegrationConnectionInput = z.infer<typeof updateIntegrationConnectionSchema>

/** Reconnect / rotate: replace one or both secrets on a live connection. */
export const rotateIntegrationCredentialsSchema = z
  .object({
    apiKey: z.string().min(8).max(4096),
    webhookSecret: z.string().min(16).max(512),
  })
  .partial()
  .refine((value) => value.apiKey !== undefined || value.webhookSecret !== undefined, {
    message: "provide apiKey, webhookSecret or both",
  })

export type RotateIntegrationCredentialsInput = z.infer<typeof rotateIntegrationCredentialsSchema>

/* ------------------------------ responses ----------------------------- */

export const integrationConnectionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  providerId: z.string(),
  displayName: z.string(),
  status: z.string(),
  authKind: z.string(),
  externalAccountId: z.string().nullable().optional(),
  config: z.record(z.unknown()).nullable().optional(),
  connectedAt: z.unknown(),
  disconnectedAt: z.unknown(),
  lastHealthCheckAt: z.unknown(),
  lastHealthStatus: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
  lastErrorAt: z.unknown(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type IntegrationConnectionDto = z.infer<typeof integrationConnectionSchema>

/** Credential METADATA only: masked hint, scopes, dates. Never a secret. */
export const integrationCredentialMetadataSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  kind: z.string(),
  hint: z.string().nullable(),
  scopes: z.array(z.string()).default([]),
  expiresAt: z.unknown(),
  lastUsedAt: z.unknown(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type IntegrationCredentialMetadataDto = z.infer<typeof integrationCredentialMetadataSchema>

export const integrationProviderSummarySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string().nullable().optional(),
  category: z.string(),
  capabilities: z.array(z.string()),
  authKind: z.string(),
  secretLabel: z.string().nullable().optional(),
  docsUrl: z.string().nullable().optional(),
  supportsWebhooks: z.boolean(),
  /** Live connections in this workspace for this provider. */
  connectionCount: z.number().int().nonnegative(),
})

export type IntegrationProviderSummaryDto = z.infer<typeof integrationProviderSummarySchema>

export const integrationWebhookEventSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  providerId: z.string(),
  providerEventId: z.string(),
  eventType: z.string().nullable().optional(),
  status: z.string(),
  error: z.string().nullable().optional(),
  receivedAt: z.unknown(),
  processedAt: z.unknown(),
})

export type IntegrationWebhookEventDto = z.infer<typeof integrationWebhookEventSchema>
