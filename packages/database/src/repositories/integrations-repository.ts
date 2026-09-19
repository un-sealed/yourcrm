import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto"
import { and, desc, eq, isNull, type SQL } from "drizzle-orm"
import { loadEnv } from "@yourcrm/config"
import type { Database } from "../client"
import {
  integrationConnections,
  integrationCredentials,
  integrationWebhookEvents,
  isIntegrationConnectionStatusValue,
  isIntegrationCredentialKindValue,
  type IntegrationConnectionRow,
  type IntegrationCredentialKindValue,
  type IntegrationCredentialRow,
  type IntegrationWebhookEventRow,
  type IntegrationWebhookEventStatusValue,
} from "../schema/integrations"
import { createBaseRepository } from "./base-repository"

/* -------------------------------------------------------------------------
 * Credential encryption at rest
 * ---------------------------------------------------------------------- */

/**
 * AES-256-GCM sealed secret. This is the ONLY representation of a credential
 * that ever reaches Postgres — `integration_credentials` has no plaintext
 * column, so there is nothing for a stray `SELECT *`, export or log line to
 * leak.
 *
 * Encryption lives in the repository on purpose: "encrypted at rest" is a
 * persistence concern, and keeping it here means the domain service handles
 * plaintext only in the two places that must (`putCredential` on connect,
 * `readCredentialSecret` when calling a provider).
 */
export type IntegrationSealedSecret = {
  algorithm: "aes-256-gcm"
  keyVersion: string
  /** base64 */
  ciphertext: string
  /** base64, 12 random bytes, never reused. */
  iv: string
  /** base64, 16-byte GCM authentication tag. */
  authTag: string
}

export class IntegrationCredentialCryptoError extends Error {
  readonly code = "CREDENTIAL_CRYPTO_ERROR"
  constructor(message: string) {
    super(message)
    this.name = "IntegrationCredentialCryptoError"
  }
}

const INTEGRATION_KEY_VERSION = "v1"
const INTEGRATION_KEY_SALT = "yourcrm.integrations.credentials"
const INTEGRATION_KEY_INFO = "aes-256-gcm"
const INTEGRATION_IV_BYTES = 12

/**
 * Derive the 32-byte data key from the configured `ENCRYPTION_KEY`.
 *
 * HKDF-SHA256 with a fixed salt/info pair: deterministic (the same key always
 * derives the same data key, so existing rows keep decrypting), domain
 * separated (the integrations data key is not the session key), and correct
 * for a high-entropy configured secret. `key_version` on the row pins the
 * derivation so a future rotation can re-seal rows lazily.
 */
function deriveIntegrationKey(encryptionKey: string): Buffer {
  if (encryptionKey.length < 32) {
    throw new IntegrationCredentialCryptoError("ENCRYPTION_KEY must be at least 32 characters")
  }
  return Buffer.from(
    hkdfSync("sha256", encryptionKey, INTEGRATION_KEY_SALT, INTEGRATION_KEY_INFO, 32),
  )
}

export type IntegrationCipher = {
  readonly keyVersion: string
  /** Encrypt one secret. A fresh random IV is generated per call. */
  seal(plaintext: string): IntegrationSealedSecret
  /** Decrypt; throws `IntegrationCredentialCryptoError` if authentication fails. */
  open(sealed: IntegrationSealedSecret): string
}

/**
 * AES-256-GCM cipher over a configured key.
 *
 * - random 12-byte IV per `seal()` — two seals of the same plaintext produce
 *   different ciphertext, and an IV is never reused;
 * - the GCM auth tag is stored alongside and verified on `open()`, so a
 *   tampered ciphertext, IV or tag raises instead of returning garbage.
 */
export function createIntegrationCipher(
  encryptionKey: string,
  keyVersion: string = INTEGRATION_KEY_VERSION,
): IntegrationCipher {
  const key = deriveIntegrationKey(encryptionKey)
  return {
    keyVersion,
    seal(plaintext: string): IntegrationSealedSecret {
      if (plaintext.length === 0) {
        throw new IntegrationCredentialCryptoError("refusing to seal an empty secret")
      }
      const iv = randomBytes(INTEGRATION_IV_BYTES)
      const cipher = createCipheriv("aes-256-gcm", key, iv)
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
      return {
        algorithm: "aes-256-gcm",
        keyVersion,
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
      }
    },
    open(sealed: IntegrationSealedSecret): string {
      if (sealed.algorithm !== "aes-256-gcm") {
        throw new IntegrationCredentialCryptoError(
          `unsupported credential algorithm "${sealed.algorithm}"`,
        )
      }
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"))
        decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"))
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(sealed.ciphertext, "base64")),
          decipher.final(),
        ])
        return plaintext.toString("utf8")
      } catch {
        // Never surface the underlying OpenSSL message or any byte of input.
        throw new IntegrationCredentialCryptoError(
          "credential failed authentication (wrong key or tampered ciphertext)",
        )
      }
    },
  }
}

let cachedCipher: IntegrationCipher | null = null

/**
 * Process cipher bound to `ENCRYPTION_KEY` from `@yourcrm/config`. Resolved
 * lazily so importing this module never touches the environment (route
 * factories stay side-effect free).
 */
export function getIntegrationCipher(): IntegrationCipher {
  return (cachedCipher ??= createIntegrationCipher(loadEnv().ENCRYPTION_KEY))
}

/** Test helper: drop the cached cipher after changing `ENCRYPTION_KEY`. */
export function resetIntegrationCipher(): void {
  cachedCipher = null
}

/**
 * Masked display value for a secret: `sk-…4f2a`. The only credential-derived
 * value an API response may contain. Short secrets degrade to `••••` rather
 * than revealing a meaningful fraction of themselves.
 */
export function maskIntegrationSecret(plaintext: string): string {
  const value = plaintext.trim()
  if (value.length < 12) return "••••"
  const prefixEnd = Math.min(value.indexOf("-") + 1, 6)
  const prefix = prefixEnd > 0 ? value.slice(0, prefixEnd) : value.slice(0, 2)
  return `${prefix}…${value.slice(-4)}`
}

/* -------------------------------------------------------------------------
 * Rows and inputs
 * ---------------------------------------------------------------------- */

export type CreateIntegrationConnectionInput = {
  providerId: string
  displayName: string
  status?: string
  authKind?: string
  externalAccountId?: string | null
  config?: Record<string, unknown>
  connectedAt?: Date | null
}

export type UpdateIntegrationConnectionInput = {
  displayName?: string
  status?: string
  externalAccountId?: string | null
  config?: Record<string, unknown>
  connectedAt?: Date | null
  disconnectedAt?: Date | null
  lastHealthCheckAt?: Date | null
  lastHealthStatus?: string | null
  lastError?: string | null
  lastErrorAt?: Date | null
}

/** Everything about a credential EXCEPT the secret. Safe to serialise. */
export type IntegrationCredentialMetadata = {
  id: string
  connectionId: string
  kind: IntegrationCredentialKindValue
  hint: string | null
  scopes: string[]
  algorithm: string
  keyVersion: string
  expiresAt: Date | null
  lastUsedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type PutIntegrationCredentialInput = {
  connectionId: string
  kind: IntegrationCredentialKindValue
  /** Plaintext. Sealed before it reaches SQL; never stored or logged as-is. */
  secret: string
  scopes?: readonly string[]
  expiresAt?: Date | null
}

export type RecordIntegrationWebhookEventInput = {
  connectionId: string
  providerId: string
  providerEventId: string
  eventType?: string | null
  payload?: unknown
}

function toCredentialMetadata(row: IntegrationCredentialRow): IntegrationCredentialMetadata {
  return {
    id: row.id,
    connectionId: row.connectionId,
    kind: isIntegrationCredentialKindValue(row.kind) ? row.kind : "api_key",
    hint: row.hint,
    scopes: row.scopes ?? [],
    algorithm: row.algorithm,
    keyVersion: row.keyVersion,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function assertConnectionStatus(status: string): string {
  if (!isIntegrationConnectionStatusValue(status)) {
    throw new Error("integrations.connection: status must be one of connected, disconnected, error")
  }
  return status
}

/** Trimmed, non-empty connection name (max 255, mirrors the column). */
export function normalizeIntegrationDisplayName(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0)
    throw new Error("integrations.connection: displayName must not be empty")
  if (trimmed.length > 255) {
    throw new Error("integrations.connection: displayName must be at most 255 characters")
  }
  return trimmed
}

/* -------------------------------------------------------------------------
 * Repository
 * ---------------------------------------------------------------------- */

/**
 * Workspace-scoped integration connections, sealed credentials and inbound
 * webhook events.
 *
 * The credential API is deliberately asymmetric: writes take plaintext and
 * seal it, reads return METADATA ONLY. The single way to obtain a plaintext
 * secret is `readCredentialSecret()`, which exists so the domain service can
 * hand it to a provider hook — it is never part of a list or detail payload.
 */
export function createIntegrationsRepository(cipher: IntegrationCipher = getIntegrationCipher()) {
  const connections = createBaseRepository(integrationConnections)

  return {
    cipher,

    async listConnections(
      db: Database,
      opts: {
        workspaceId: string
        limit?: number
        cursor?: string
        order?: "asc" | "desc"
        providerId?: string
        status?: string
      },
    ) {
      const where: SQL[] = []
      if (opts.providerId) {
        where.push(eq(integrationConnections.providerId, opts.providerId))
      }
      if (opts.status) {
        where.push(eq(integrationConnections.status, assertConnectionStatus(opts.status)))
      }
      const result = await connections.list(db, { ...opts, where })
      return {
        data: result.data as IntegrationConnectionRow[],
        pagination: result.pagination,
      }
    },

    async findConnectionById(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<IntegrationConnectionRow | null> {
      const row = await connections.findById(db, workspaceId, id)
      return (row as IntegrationConnectionRow | null) ?? null
    },

    /**
     * Connection lookup for the webhook endpoint: no workspace is known
     * before the connection is resolved (the caller is the provider, not a
     * session). Everything downstream is scoped by the workspace on the row.
     */
    async findConnectionForWebhook(
      db: Database,
      id: string,
    ): Promise<IntegrationConnectionRow | null> {
      const rows = await db
        .select()
        .from(integrationConnections)
        .where(and(eq(integrationConnections.id, id), isNull(integrationConnections.deletedAt)))
        .limit(1)
      return rows[0] ?? null
    },

    async createConnection(
      db: Database,
      workspaceId: string,
      input: CreateIntegrationConnectionInput,
      actorId?: string,
    ): Promise<IntegrationConnectionRow> {
      const rows = await db
        .insert(integrationConnections)
        .values({
          workspaceId,
          providerId: input.providerId,
          displayName: normalizeIntegrationDisplayName(input.displayName),
          status: assertConnectionStatus(input.status ?? "disconnected"),
          authKind: input.authKind ?? "api_key",
          externalAccountId: input.externalAccountId ?? null,
          config: input.config ?? {},
          connectedAt: input.connectedAt ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("integrations.createConnection: insert returned no rows")
      return row
    },

    async updateConnection(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateIntegrationConnectionInput,
      actorId?: string,
    ): Promise<IntegrationConnectionRow | null> {
      const values: Record<string, unknown> = { updatedAt: new Date() }
      if (input.displayName !== undefined) {
        values.displayName = normalizeIntegrationDisplayName(input.displayName)
      }
      if (input.status !== undefined) values.status = assertConnectionStatus(input.status)
      if (input.externalAccountId !== undefined) values.externalAccountId = input.externalAccountId
      if (input.config !== undefined) values.config = input.config
      if (input.connectedAt !== undefined) values.connectedAt = input.connectedAt
      if (input.disconnectedAt !== undefined) values.disconnectedAt = input.disconnectedAt
      if (input.lastHealthCheckAt !== undefined) values.lastHealthCheckAt = input.lastHealthCheckAt
      if (input.lastHealthStatus !== undefined) values.lastHealthStatus = input.lastHealthStatus
      if (input.lastError !== undefined) values.lastError = input.lastError
      if (input.lastErrorAt !== undefined) values.lastErrorAt = input.lastErrorAt
      if (actorId !== undefined) values.updatedBy = actorId

      const rows = await db
        .update(integrationConnections)
        .set(values)
        .where(
          and(
            eq(integrationConnections.id, id),
            eq(integrationConnections.workspaceId, workspaceId),
            isNull(integrationConnections.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    async softDeleteConnection(
      db: Database,
      workspaceId: string,
      id: string,
      actorId?: string,
    ): Promise<void> {
      await connections.softDelete(db, workspaceId, id, actorId)
    },

    /* --------------------------- credentials --------------------------- */

    /**
     * Seal and store a secret in the (connection, kind) slot, replacing any
     * existing one. Returns metadata only — the caller never gets ciphertext.
     */
    async putCredential(
      db: Database,
      workspaceId: string,
      input: PutIntegrationCredentialInput,
      actorId?: string,
    ): Promise<IntegrationCredentialMetadata> {
      const sealed = cipher.seal(input.secret)
      await this.deleteCredential(db, workspaceId, input.connectionId, input.kind)
      const rows = await db
        .insert(integrationCredentials)
        .values({
          workspaceId,
          connectionId: input.connectionId,
          kind: input.kind,
          algorithm: sealed.algorithm,
          keyVersion: sealed.keyVersion,
          ciphertext: sealed.ciphertext,
          iv: sealed.iv,
          authTag: sealed.authTag,
          hint: maskIntegrationSecret(input.secret),
          scopes: [...(input.scopes ?? [])],
          expiresAt: input.expiresAt ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("integrations.putCredential: insert returned no rows")
      return toCredentialMetadata(row)
    },

    /** Credential metadata for a connection. Never includes a secret. */
    async listCredentialMetadata(
      db: Database,
      workspaceId: string,
      connectionId: string,
    ): Promise<IntegrationCredentialMetadata[]> {
      const rows = await db
        .select()
        .from(integrationCredentials)
        .where(
          and(
            eq(integrationCredentials.connectionId, connectionId),
            eq(integrationCredentials.workspaceId, workspaceId),
            isNull(integrationCredentials.deletedAt),
          ),
        )
      return rows.map(toCredentialMetadata)
    },

    /**
     * Decrypt one credential. The ONLY path to plaintext. Callers pass it
     * straight to a provider hook and must not log, persist or return it.
     */
    async readCredentialSecret(
      db: Database,
      workspaceId: string,
      connectionId: string,
      kind: IntegrationCredentialKindValue,
    ): Promise<string | null> {
      const rows = await db
        .select()
        .from(integrationCredentials)
        .where(
          and(
            eq(integrationCredentials.connectionId, connectionId),
            eq(integrationCredentials.workspaceId, workspaceId),
            eq(integrationCredentials.kind, kind),
            isNull(integrationCredentials.deletedAt),
          ),
        )
        .limit(1)
      const row = rows[0]
      if (!row) return null
      return cipher.open({
        algorithm: "aes-256-gcm",
        keyVersion: row.keyVersion,
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.authTag,
      })
    },

    /** Hard-delete one credential slot: revoked secrets must not linger. */
    async deleteCredential(
      db: Database,
      workspaceId: string,
      connectionId: string,
      kind: IntegrationCredentialKindValue,
    ): Promise<void> {
      await db
        .delete(integrationCredentials)
        .where(
          and(
            eq(integrationCredentials.connectionId, connectionId),
            eq(integrationCredentials.workspaceId, workspaceId),
            eq(integrationCredentials.kind, kind),
          ),
        )
    },

    /** Hard-delete every credential for a connection (disconnect/revoke). */
    async deleteCredentials(
      db: Database,
      workspaceId: string,
      connectionId: string,
    ): Promise<void> {
      await db
        .delete(integrationCredentials)
        .where(
          and(
            eq(integrationCredentials.connectionId, connectionId),
            eq(integrationCredentials.workspaceId, workspaceId),
          ),
        )
    },

    /* ------------------------- webhook events -------------------------- */

    /** Idempotency probe: has this provider event already been recorded? */
    async findWebhookEvent(
      db: Database,
      connectionId: string,
      providerEventId: string,
    ): Promise<IntegrationWebhookEventRow | null> {
      const rows = await db
        .select()
        .from(integrationWebhookEvents)
        .where(
          and(
            eq(integrationWebhookEvents.connectionId, connectionId),
            eq(integrationWebhookEvents.providerEventId, providerEventId),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },

    async recordWebhookEvent(
      db: Database,
      workspaceId: string,
      input: RecordIntegrationWebhookEventInput,
    ): Promise<IntegrationWebhookEventRow> {
      const rows = await db
        .insert(integrationWebhookEvents)
        .values({
          workspaceId,
          connectionId: input.connectionId,
          providerId: input.providerId,
          providerEventId: input.providerEventId,
          eventType: input.eventType ?? null,
          status: "received",
          payload: input.payload ?? null,
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("integrations.recordWebhookEvent: insert returned no rows")
      return row
    },

    async markWebhookEvent(
      db: Database,
      workspaceId: string,
      id: string,
      status: IntegrationWebhookEventStatusValue,
      patch: { eventType?: string | null; error?: string | null } = {},
    ): Promise<IntegrationWebhookEventRow | null> {
      const rows = await db
        .update(integrationWebhookEvents)
        .set({
          status,
          processedAt: new Date(),
          updatedAt: new Date(),
          ...(patch.eventType === undefined ? {} : { eventType: patch.eventType }),
          ...(patch.error === undefined ? {} : { error: patch.error }),
        })
        .where(
          and(
            eq(integrationWebhookEvents.id, id),
            eq(integrationWebhookEvents.workspaceId, workspaceId),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    /** Most recent deliveries for a connection — the error queue view. */
    async listWebhookEvents(
      db: Database,
      workspaceId: string,
      connectionId: string,
      limit = 25,
    ): Promise<IntegrationWebhookEventRow[]> {
      return db
        .select()
        .from(integrationWebhookEvents)
        .where(
          and(
            eq(integrationWebhookEvents.connectionId, connectionId),
            eq(integrationWebhookEvents.workspaceId, workspaceId),
          ),
        )
        .orderBy(desc(integrationWebhookEvents.receivedAt))
        .limit(Math.min(Math.max(limit, 1), 200))
    },
  }
}

export type IntegrationsRepository = ReturnType<typeof createIntegrationsRepository>
