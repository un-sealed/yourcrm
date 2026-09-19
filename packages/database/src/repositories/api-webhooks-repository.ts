import { createHash } from "node:crypto"
import { and, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import {
  isPublicApiKeyRoleValue,
  isWebhookDeliveryStatusValue,
  publicApiKeys,
  webhookDeliveries,
  webhookSubscriptions,
  type PublicApiKeyRow,
  type WebhookDeliveryAttemptRecord,
  type WebhookDeliveryRow,
  type WebhookDeliveryStatusValue,
  type WebhookSubscriptionRow,
} from "../schema/api-webhooks"
import { createBaseRepository } from "./base-repository"
import {
  getIntegrationCipher,
  maskIntegrationSecret,
  type IntegrationCipher,
} from "./integrations-repository"

/**
 * Outbound webhooks + public API keys (spec 32-api-webhooks, P0).
 *
 * ## Secret handling — reused, not reinvented
 *
 * The signing secret is sealed with the SAME cipher the integrations
 * module already uses (`createIntegrationCipher`, AES-256-GCM over an
 * HKDF-derived key from `ENCRYPTION_KEY`). This module is the outbound
 * direction of the same idea, so there is one cipher, one key derivation
 * and one place to audit. The cipher is injected so a test can supply its
 * own key without touching the process environment.
 *
 * The API key is HASHED instead, because it never needs to be reproduced —
 * see the note in `@yourcrm/crm/src/api-webhooks/api-keys.ts`.
 *
 * BLOCKER (integrator): the hash below is the same construction as
 * `hashSessionToken` in `@yourcrm/auth` (SHA-256 hex over the raw token),
 * but `packages/database` does not declare `@yourcrm/auth` and agents may
 * not edit `package.json`. When that dependency is declared, delete
 * `hashApiKey` and import `hashSessionToken`; the stored values are
 * byte-identical, so no migration is needed.
 *
 * ## Asymmetry, on purpose
 *
 * Writes take plaintext; reads return metadata. `readSubscriptionSecret()`
 * is the only path to a plaintext signing secret and exists solely so the
 * delivery signer can use it. There is no equivalent for an API key at all.
 */

/* -------------------------------------------------------------------------
 * Hashing
 * ---------------------------------------------------------------------- */

/** SHA-256 hex of a raw API key. The raw key is never stored or logged. */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex")
}

/* -------------------------------------------------------------------------
 * Inputs
 * ---------------------------------------------------------------------- */

export type CreateWebhookSubscriptionInput = {
  name: string
  description?: string | null
  targetUrl: string
  eventNames: string[]
  active?: boolean
  /** Plaintext. Sealed before it reaches SQL. */
  secret: string
}

export type UpdateWebhookSubscriptionInput = {
  name?: string
  description?: string | null
  targetUrl?: string
  eventNames?: string[]
  active?: boolean
  disabledAt?: Date | null
  disabledReason?: string | null
  consecutiveFailures?: number
}

export type CreateWebhookDeliveryInput = {
  subscriptionId: string
  eventId: string
  eventName: string
  body: string
  maxAttempts: number
  replayOfId?: string | null
}

export type RecordWebhookAttemptInput = {
  attempt: WebhookDeliveryAttemptRecord
  status: "succeeded" | "failed" | "dead_lettered"
  nextAttemptAt: Date | null
  deadLetterReason: string | null
  at: Date
}

export type CreatePublicApiKeyInput = {
  name: string
  role: string
  /** Plaintext. Hashed before it reaches SQL; never stored as-is. */
  rawKey: string
  keyPrefix: string
  lastFour: string
  expiresAt?: Date | null
}

/** Everything the auth path needs. Carries no key material. */
export type ResolvedPublicApiKeyRow = {
  id: string
  workspaceId: string
  name: string
  role: string
  createdBy: string | null
  expiresAt: Date | null
}

/* -------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------- */

function assertDeliveryStatus(status: string): WebhookDeliveryStatusValue {
  if (!isWebhookDeliveryStatusValue(status)) {
    throw new Error(
      "api-webhooks.delivery: status must be one of pending, delivering, succeeded, failed, dead_lettered",
    )
  }
  return status
}

function assertApiKeyRole(role: string): string {
  if (!isPublicApiKeyRoleValue(role)) {
    throw new Error("api-webhooks.apiKey: role must be one of owner, admin, member, viewer")
  }
  return role
}

/** Trimmed, non-empty subscription name (max 255, mirrors the column). */
export function normalizeWebhookSubscriptionName(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new Error("api-webhooks.subscription: name must not be empty")
  if (trimmed.length > 255) {
    throw new Error("api-webhooks.subscription: name must be at most 255 characters")
  }
  return trimmed
}

/* -------------------------------------------------------------------------
 * Repository
 * ---------------------------------------------------------------------- */

export function createApiWebhooksRepository(cipher: IntegrationCipher = getIntegrationCipher()) {
  const subscriptions = createBaseRepository(webhookSubscriptions)
  const deliveries = createBaseRepository(webhookDeliveries)
  const keys = createBaseRepository(publicApiKeys)

  const sealed = (secret: string) => {
    const seal = cipher.seal(secret)
    return {
      secretAlgorithm: seal.algorithm,
      secretKeyVersion: seal.keyVersion,
      secretCiphertext: seal.ciphertext,
      secretIv: seal.iv,
      secretAuthTag: seal.authTag,
      secretHint: maskIntegrationSecret(secret),
    }
  }

  return {
    cipher,

    /* ------------------------- subscriptions ------------------------- */

    async listSubscriptions(
      db: Database,
      opts: {
        workspaceId: string
        limit?: number
        cursor?: string
        order?: "asc" | "desc"
        active?: boolean
        event?: string
      },
    ) {
      const where: SQL[] = []
      if (opts.active !== undefined) where.push(eq(webhookSubscriptions.active, opts.active))
      if (opts.event) {
        // Containment on the jsonb array — the same predicate
        // `findActiveSubscriptionsForEvent` uses, so list and dispatch can
        // never disagree about what a subscription listens to.
        where.push(
          sql`${webhookSubscriptions.eventNames} @> ${JSON.stringify([opts.event])}::jsonb`,
        )
      }
      const result = await subscriptions.list(db, { ...opts, where })
      return { data: result.data as WebhookSubscriptionRow[], pagination: result.pagination }
    },

    async findSubscriptionById(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<WebhookSubscriptionRow | null> {
      const row = await subscriptions.findById(db, workspaceId, id)
      return (row as WebhookSubscriptionRow | null) ?? null
    },

    /**
     * Active subscriptions listening for one event. The dispatcher runs off
     * the bus with no session, so the event's own workspace is the scope.
     */
    async findActiveSubscriptionsForEvent(
      db: Database,
      workspaceId: string,
      eventName: string,
    ): Promise<WebhookSubscriptionRow[]> {
      return db
        .select()
        .from(webhookSubscriptions)
        .where(
          and(
            eq(webhookSubscriptions.workspaceId, workspaceId),
            isNull(webhookSubscriptions.deletedAt),
            eq(webhookSubscriptions.active, true),
            sql`${webhookSubscriptions.eventNames} @> ${JSON.stringify([eventName])}::jsonb`,
          ),
        )
    },

    async createSubscription(
      db: Database,
      workspaceId: string,
      input: CreateWebhookSubscriptionInput,
      actorId?: string,
    ): Promise<WebhookSubscriptionRow> {
      const rows = await db
        .insert(webhookSubscriptions)
        .values({
          workspaceId,
          name: normalizeWebhookSubscriptionName(input.name),
          description: input.description ?? null,
          targetUrl: input.targetUrl,
          eventNames: input.eventNames,
          active: input.active ?? true,
          ...sealed(input.secret),
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("api-webhooks.createSubscription: insert returned no rows")
      return row
    },

    async updateSubscription(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateWebhookSubscriptionInput,
      actorId?: string,
    ): Promise<WebhookSubscriptionRow | null> {
      const patch: Record<string, unknown> = { updatedAt: new Date() }
      if (input.name !== undefined) patch.name = normalizeWebhookSubscriptionName(input.name)
      if (input.description !== undefined) patch.description = input.description
      if (input.targetUrl !== undefined) patch.targetUrl = input.targetUrl
      if (input.eventNames !== undefined) patch.eventNames = input.eventNames
      if (input.active !== undefined) patch.active = input.active
      if (input.disabledAt !== undefined) patch.disabledAt = input.disabledAt
      if (input.disabledReason !== undefined) patch.disabledReason = input.disabledReason
      if (input.consecutiveFailures !== undefined) {
        patch.consecutiveFailures = input.consecutiveFailures
      }
      if (actorId !== undefined) patch.updatedBy = actorId

      const rows = await db
        .update(webhookSubscriptions)
        .set(patch)
        .where(
          and(
            eq(webhookSubscriptions.id, id),
            eq(webhookSubscriptions.workspaceId, workspaceId),
            isNull(webhookSubscriptions.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    /** Re-seal with a new secret. Returns the row, never the secret. */
    async rotateSubscriptionSecret(
      db: Database,
      workspaceId: string,
      id: string,
      secret: string,
      actorId?: string,
    ): Promise<WebhookSubscriptionRow | null> {
      const rows = await db
        .update(webhookSubscriptions)
        .set({
          ...sealed(secret),
          secretRotatedAt: new Date(),
          updatedAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(
          and(
            eq(webhookSubscriptions.id, id),
            eq(webhookSubscriptions.workspaceId, workspaceId),
            isNull(webhookSubscriptions.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    /**
     * THE only path to a plaintext signing secret. One caller: the delivery
     * signer. It takes no workspace because the worker has no session — the
     * delivery row it came from already established the scope.
     */
    async readSubscriptionSecret(db: Database, subscriptionId: string): Promise<string | null> {
      const rows = await db
        .select({
          algorithm: webhookSubscriptions.secretAlgorithm,
          keyVersion: webhookSubscriptions.secretKeyVersion,
          ciphertext: webhookSubscriptions.secretCiphertext,
          iv: webhookSubscriptions.secretIv,
          authTag: webhookSubscriptions.secretAuthTag,
        })
        .from(webhookSubscriptions)
        .where(
          and(eq(webhookSubscriptions.id, subscriptionId), isNull(webhookSubscriptions.deletedAt)),
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

    async softDeleteSubscription(
      db: Database,
      workspaceId: string,
      id: string,
      actorId?: string,
    ): Promise<void> {
      await subscriptions.softDelete(db, workspaceId, id, actorId)
    },

    /**
     * Fold one terminal delivery outcome into the subscription's health
     * counters, in SQL, so concurrent workers cannot lose an increment to
     * a read-modify-write race.
     */
    async recordSubscriptionOutcome(
      db: Database,
      subscriptionId: string,
      outcome: { at: Date; status: string; failed: boolean },
    ): Promise<{ consecutiveFailures: number }> {
      const rows = await db
        .update(webhookSubscriptions)
        .set({
          consecutiveFailures: outcome.failed
            ? sql`${webhookSubscriptions.consecutiveFailures} + 1`
            : 0,
          lastDeliveryAt: outcome.at,
          lastDeliveryStatus: outcome.status,
          updatedAt: outcome.at,
        })
        .where(eq(webhookSubscriptions.id, subscriptionId))
        .returning({ consecutiveFailures: webhookSubscriptions.consecutiveFailures })
      return { consecutiveFailures: rows[0]?.consecutiveFailures ?? 0 }
    },

    /* --------------------------- deliveries -------------------------- */

    async listDeliveries(
      db: Database,
      opts: {
        workspaceId: string
        limit?: number
        cursor?: string
        order?: "asc" | "desc"
        subscriptionId?: string
        status?: string
        event?: string
      },
    ) {
      const where: SQL[] = []
      if (opts.subscriptionId) {
        where.push(eq(webhookDeliveries.subscriptionId, opts.subscriptionId))
      }
      if (opts.status) where.push(eq(webhookDeliveries.status, assertDeliveryStatus(opts.status)))
      if (opts.event) where.push(eq(webhookDeliveries.eventName, opts.event))
      const result = await deliveries.list(db, { ...opts, where })
      return { data: result.data as WebhookDeliveryRow[], pagination: result.pagination }
    },

    async findDeliveryById(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<WebhookDeliveryRow | null> {
      const row = await deliveries.findById(db, workspaceId, id)
      return (row as WebhookDeliveryRow | null) ?? null
    },

    /** Worker path: resolve a queued delivery with no session in hand. */
    async findDeliveryForWorker(db: Database, id: string): Promise<WebhookDeliveryRow | null> {
      const rows = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, id))
        .limit(1)
      return rows[0] ?? null
    },

    /**
     * IDEMPOTENCY. `ON CONFLICT DO NOTHING` against
     * `webhook_deliveries_idempotency_uidx` makes this one atomic
     * statement: a redelivered event or a racing dispatcher returns the
     * existing row with `created: false` instead of a second delivery.
     * Implementing it as SELECT-then-INSERT would reopen exactly the race
     * the index exists to close.
     */
    async createDeliveryIfAbsent(
      db: Database,
      workspaceId: string,
      input: CreateWebhookDeliveryInput,
    ): Promise<{ delivery: WebhookDeliveryRow; created: boolean }> {
      const inserted = await db
        .insert(webhookDeliveries)
        .values({
          workspaceId,
          subscriptionId: input.subscriptionId,
          eventId: input.eventId,
          eventName: input.eventName,
          body: input.body,
          maxAttempts: input.maxAttempts,
          status: "pending",
          replayOfId: input.replayOfId ?? null,
        })
        .onConflictDoNothing({
          target: [webhookDeliveries.subscriptionId, webhookDeliveries.eventId],
        })
        .returning()
      const created = inserted[0]
      if (created) return { delivery: created, created: true }

      const existing = await db
        .select()
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.subscriptionId, input.subscriptionId),
            eq(webhookDeliveries.eventId, input.eventId),
          ),
        )
        .limit(1)
      const row = existing[0]
      if (!row) throw new Error("api-webhooks.createDeliveryIfAbsent: conflict row disappeared")
      return { delivery: row, created: false }
    },

    /**
     * Claim a delivery for one attempt.
     *
     * A single conditional UPDATE: only `pending` or `failed` rows move to
     * `delivering`, and the count increments in the same statement. Two
     * workers racing on the same job produce exactly one winner; the loser
     * gets null and does nothing. This is what makes a retried BullMQ job
     * safe, not a convention the handler has to remember.
     */
    async claimDelivery(db: Database, id: string, at: Date): Promise<WebhookDeliveryRow | null> {
      const rows = await db
        .update(webhookDeliveries)
        .set({
          status: "delivering",
          attemptCount: sql`${webhookDeliveries.attemptCount} + 1`,
          updatedAt: at,
        })
        .where(
          and(
            eq(webhookDeliveries.id, id),
            inArray(webhookDeliveries.status, ["pending", "failed"]),
            sql`${webhookDeliveries.attemptCount} < ${webhookDeliveries.maxAttempts}`,
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    async recordDeliveryAttempt(
      db: Database,
      id: string,
      input: RecordWebhookAttemptInput,
    ): Promise<WebhookDeliveryRow | null> {
      const rows = await db
        .update(webhookDeliveries)
        .set({
          status: input.status,
          attempts: sql`${webhookDeliveries.attempts} || ${JSON.stringify([input.attempt])}::jsonb`,
          nextAttemptAt: input.nextAttemptAt,
          lastStatusCode: input.attempt.statusCode,
          lastResponseSnippet: input.attempt.responseSnippet,
          lastDurationMs: input.attempt.durationMs,
          lastError: input.attempt.error,
          succeededAt: input.status === "succeeded" ? input.at : null,
          deadLetteredAt: input.status === "dead_lettered" ? input.at : null,
          deadLetterReason: input.deadLetterReason,
          updatedAt: input.at,
        })
        .where(eq(webhookDeliveries.id, id))
        .returning()
      return rows[0] ?? null
    },

    /* ---------------------------- api keys --------------------------- */

    async listApiKeys(
      db: Database,
      opts: {
        workspaceId: string
        limit?: number
        cursor?: string
        order?: "asc" | "desc"
        includeRevoked?: boolean
      },
    ) {
      const where: SQL[] = []
      if (!opts.includeRevoked) where.push(isNull(publicApiKeys.revokedAt))
      const result = await keys.list(db, { ...opts, where })
      return { data: result.data as PublicApiKeyRow[], pagination: result.pagination }
    },

    async findApiKeyById(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<PublicApiKeyRow | null> {
      const row = await keys.findById(db, workspaceId, id)
      return (row as PublicApiKeyRow | null) ?? null
    },

    async createApiKey(
      db: Database,
      workspaceId: string,
      input: CreatePublicApiKeyInput,
      actorId?: string,
    ): Promise<PublicApiKeyRow> {
      const rows = await db
        .insert(publicApiKeys)
        .values({
          workspaceId,
          name: input.name.trim(),
          role: assertApiKeyRole(input.role),
          // Only the digest. There is no column the raw key could go in.
          keyHash: hashApiKey(input.rawKey),
          keyPrefix: input.keyPrefix,
          lastFour: input.lastFour,
          expiresAt: input.expiresAt ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("api-webhooks.createApiKey: insert returned no rows")
      return row
    },

    /**
     * Authentication lookup. Every disqualifier — unknown hash, revoked,
     * soft-deleted, expired — is expressed in the same WHERE clause and
     * yields the same null, so a caller cannot distinguish "wrong key" from
     * "revoked key" by response or by timing of an extra query.
     */
    async findApiKeyByRawKey(
      db: Database,
      rawKey: string,
      now: Date,
    ): Promise<ResolvedPublicApiKeyRow | null> {
      const rows = await db
        .select({
          id: publicApiKeys.id,
          workspaceId: publicApiKeys.workspaceId,
          name: publicApiKeys.name,
          role: publicApiKeys.role,
          createdBy: publicApiKeys.createdBy,
          expiresAt: publicApiKeys.expiresAt,
        })
        .from(publicApiKeys)
        .where(
          and(
            eq(publicApiKeys.keyHash, hashApiKey(rawKey)),
            isNull(publicApiKeys.deletedAt),
            isNull(publicApiKeys.revokedAt),
            or(isNull(publicApiKeys.expiresAt), gt(publicApiKeys.expiresAt, now)),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },

    async touchApiKeyLastUsed(db: Database, id: string, at: Date): Promise<void> {
      await db.update(publicApiKeys).set({ lastUsedAt: at }).where(eq(publicApiKeys.id, id))
    },

    async revokeApiKey(
      db: Database,
      workspaceId: string,
      id: string,
      actorId?: string,
    ): Promise<PublicApiKeyRow | null> {
      const at = new Date()
      const rows = await db
        .update(publicApiKeys)
        .set({
          revokedAt: at,
          updatedAt: at,
          ...(actorId === undefined ? {} : { revokedBy: actorId, updatedBy: actorId }),
        })
        .where(
          and(
            eq(publicApiKeys.id, id),
            eq(publicApiKeys.workspaceId, workspaceId),
            isNull(publicApiKeys.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },
  }
}

export type ApiWebhooksRepository = ReturnType<typeof createApiWebhooksRepository>
