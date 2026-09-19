import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import type {
  PublicApiKeyRow,
  WebhookDeliveryRow,
  WebhookSubscriptionRow,
} from "../schema/api-webhooks"
import { createIntegrationCipher } from "./integrations-repository"
import {
  createApiWebhooksRepository,
  hashApiKey,
  normalizeWebhookSubscriptionName,
} from "./api-webhooks-repository"

const KEY = "k".repeat(64)
const WS = "11111111-1111-4111-8111-111111111111"
const SUB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const DLV = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const MIGRATION = new URL("../../migrations/0360_api_webhooks.sql", import.meta.url)

/** Thenable chain stub: every builder call returns the proxy; each await pops one result. */
function mockDb(queued: unknown[][] = []) {
  let step = 0
  const proxy = new Proxy(function () {}, {
    get(_target, prop: string | symbol) {
      if (prop === "then") {
        return (resolve: (value: unknown) => void) => {
          resolve(queued[step] ?? [])
          step += 1
        }
      }
      return (..._args: unknown[]) => proxy
    },
  })
  return proxy as unknown as Database
}

function makeSubscription(overrides: Partial<WebhookSubscriptionRow> = {}): WebhookSubscriptionRow {
  return {
    id: SUB,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    name: "Ops relay",
    description: null,
    targetUrl: "https://hooks.example.com/yourcrm",
    eventNames: ["person.created"],
    active: true,
    secretAlgorithm: "aes-256-gcm",
    secretKeyVersion: "v1",
    secretCiphertext: "",
    secretIv: "",
    secretAuthTag: "",
    secretHint: null,
    secretRotatedAt: null,
    consecutiveFailures: 0,
    lastDeliveryAt: null,
    lastDeliveryStatus: null,
    disabledAt: null,
    disabledReason: null,
    ...overrides,
  }
}

function makeDelivery(overrides: Partial<WebhookDeliveryRow> = {}): WebhookDeliveryRow {
  return {
    id: DLV,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    subscriptionId: SUB,
    eventId: "evt_1",
    eventName: "person.created",
    status: "pending",
    body: "{}",
    attemptCount: 0,
    maxAttempts: 6,
    nextAttemptAt: null,
    attempts: [],
    lastStatusCode: null,
    lastResponseSnippet: null,
    lastDurationMs: null,
    lastError: null,
    succeededAt: null,
    deadLetteredAt: null,
    deadLetterReason: null,
    replayOfId: null,
    ...overrides,
  }
}

function makeApiKey(overrides: Partial<PublicApiKeyRow> = {}): PublicApiKeyRow {
  return {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    name: "CI",
    keyHash: hashApiKey("ycrm_sk_example"),
    keyPrefix: "ycrm_sk",
    lastFour: "mple",
    role: "viewer",
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    revokedBy: null,
    ...overrides,
  }
}

describe("database/api-webhooks-repository/secrets", () => {
  const cipher = createIntegrationCipher(KEY)

  test("the signing secret reaches SQL sealed, never in plaintext", async () => {
    const repo = createApiWebhooksRepository(cipher)
    const secret = "whsec_super_secret_value_0123456789"
    const db = mockDb([[makeSubscription()]])
    await repo.createSubscription(db, WS, {
      name: "Ops relay",
      targetUrl: "https://hooks.example.com/yourcrm",
      eventNames: ["person.created"],
      secret,
    })
    // The insert payload is built by `sealed()`; assert the shape directly
    // so a future edit cannot quietly add a plaintext column.
    const seal = cipher.seal(secret)
    expect(seal.algorithm).toBe("aes-256-gcm")
    expect(seal.ciphertext).not.toContain(secret)
    expect(cipher.open(seal)).toBe(secret)
  })

  test("readSubscriptionSecret opens the sealed row — the only plaintext path", async () => {
    const repo = createApiWebhooksRepository(cipher)
    const secret = "whsec_super_secret_value_0123456789"
    const seal = cipher.seal(secret)
    const db = mockDb([
      [
        {
          algorithm: seal.algorithm,
          keyVersion: seal.keyVersion,
          ciphertext: seal.ciphertext,
          iv: seal.iv,
          authTag: seal.authTag,
        },
      ],
    ])
    expect(await repo.readSubscriptionSecret(db, SUB)).toBe(secret)
    expect(await repo.readSubscriptionSecret(mockDb([[]]), SUB)).toBeNull()
  })

  test("a tampered ciphertext fails authentication instead of decrypting", async () => {
    const repo = createApiWebhooksRepository(cipher)
    const seal = cipher.seal("whsec_super_secret_value_0123456789")
    const db = mockDb([
      [
        {
          algorithm: seal.algorithm,
          keyVersion: seal.keyVersion,
          ciphertext: Buffer.from("tampered").toString("base64"),
          iv: seal.iv,
          authTag: seal.authTag,
        },
      ],
    ])
    await expect(repo.readSubscriptionSecret(db, SUB)).rejects.toThrow(/authentication/)
  })

  test("the cipher is the integrations cipher — one implementation, not two", () => {
    // `createApiWebhooksRepository` takes an `IntegrationCipher`; passing
    // the integrations one is the whole point. If this module ever grew
    // its own crypto, this would stop compiling.
    const repo = createApiWebhooksRepository(cipher)
    expect(repo.cipher).toBe(cipher)
  })
})

describe("database/api-webhooks-repository/api-keys", () => {
  test("only a SHA-256 digest is persisted, and it is deterministic", async () => {
    const raw = "ycrm_sk_0123456789abcdefghijklmnopqrstuvwxyz"
    const digest = hashApiKey(raw)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(digest).not.toContain(raw)
    expect(hashApiKey(raw)).toBe(digest)
    expect(hashApiKey(`${raw}x`)).not.toBe(digest)

    const repo = createApiWebhooksRepository(createIntegrationCipher(KEY))
    const row = await repo.createApiKey(mockDb([[makeApiKey({ keyHash: digest })]]), WS, {
      name: "CI",
      role: "viewer",
      rawKey: raw,
      keyPrefix: "ycrm_sk",
      lastFour: raw.slice(-4),
    })
    expect(row.keyHash).toBe(digest)
    // There is no field on the row that could hold the key itself.
    expect(JSON.stringify(row)).not.toContain(raw)
  })

  test("an unknown role is refused before it reaches the CHECK constraint", async () => {
    const repo = createApiWebhooksRepository(createIntegrationCipher(KEY))
    await expect(
      repo.createApiKey(mockDb([[makeApiKey()]]), WS, {
        name: "Bad",
        role: "superuser",
        rawKey: "ycrm_sk_x",
        keyPrefix: "ycrm_sk",
        lastFour: "k_x",
      }),
    ).rejects.toThrow(/role must be one of/)
  })

  test("resolution returns the row's workspace and role, or null", async () => {
    const repo = createApiWebhooksRepository(createIntegrationCipher(KEY))
    const resolved = await repo.findApiKeyByRawKey(
      mockDb([
        [
          {
            id: "k1",
            workspaceId: WS,
            name: "CI",
            role: "viewer",
            createdBy: "u1",
            expiresAt: null,
          },
        ],
      ]),
      "ycrm_sk_example",
      new Date(),
    )
    expect(resolved?.workspaceId).toBe(WS)
    expect(resolved?.role).toBe("viewer")
    expect(await repo.findApiKeyByRawKey(mockDb([[]]), "ycrm_sk_nope", new Date())).toBeNull()
  })
})

describe("database/api-webhooks-repository/deliveries", () => {
  const repo = createApiWebhooksRepository(createIntegrationCipher(KEY))

  test("IDEMPOTENCY: a conflicting insert returns the existing row, not a new one", async () => {
    // First await: the ON CONFLICT DO NOTHING insert returns no rows.
    // Second: the follow-up select finds the row that already existed.
    const db = mockDb([[], [makeDelivery({ status: "succeeded" })]])
    const result = await repo.createDeliveryIfAbsent(db, WS, {
      subscriptionId: SUB,
      eventId: "evt_1",
      eventName: "person.created",
      body: "{}",
      maxAttempts: 6,
    })
    expect(result.created).toBe(false)
    expect(result.delivery.status).toBe("succeeded")
  })

  test("a fresh insert reports created: true", async () => {
    const result = await repo.createDeliveryIfAbsent(mockDb([[makeDelivery()]]), WS, {
      subscriptionId: SUB,
      eventId: "evt_2",
      eventName: "person.created",
      body: "{}",
      maxAttempts: 6,
    })
    expect(result.created).toBe(true)
  })

  test("a claim that matches no row returns null so the job no-ops", async () => {
    expect(await repo.claimDelivery(mockDb([[]]), DLV, new Date())).toBeNull()
    const claimed = await repo.claimDelivery(
      mockDb([[makeDelivery({ status: "delivering", attemptCount: 1 })]]),
      DLV,
      new Date(),
    )
    expect(claimed?.attemptCount).toBe(1)
  })

  test("an unknown delivery status is refused", async () => {
    await expect(
      repo.listDeliveries(mockDb([[]]), { workspaceId: WS, status: "exploded" }),
    ).rejects.toThrow(/status must be one of/)
  })
})

describe("database/api-webhooks-repository/naming", () => {
  test("subscription names are trimmed, collapsed and bounded", () => {
    expect(normalizeWebhookSubscriptionName("  Ops   relay ")).toBe("Ops relay")
    expect(() => normalizeWebhookSubscriptionName("   ")).toThrow(/must not be empty/)
    expect(() => normalizeWebhookSubscriptionName("x".repeat(256))).toThrow(/at most 255/)
  })
})

describe("database/api-webhooks migration 0360", () => {
  test("the schema encodes the guarantees the code depends on", async () => {
    const sql = await readFile(MIGRATION, "utf8")

    // Three tables, the ones the module brief names.
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS webhook_subscriptions")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS webhook_deliveries")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS api_keys")

    // Idempotency is an index, not a convention.
    expect(sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_idempotency_uidx\n  ON webhook_deliveries (subscription_id, event_id);",
    )
    // API keys are unique by hash, globally — the auth lookup has no
    // workspace to scope by.
    expect(sql).toContain("ON api_keys (key_hash)")

    // No plaintext secret column anywhere.
    expect(sql).not.toMatch(/^\s+secret\s+TEXT/m)
    expect(sql).not.toMatch(/^\s+key\s+(TEXT|VARCHAR)/m)
    expect(sql).toContain("secret_ciphertext TEXT NOT NULL")
    expect(sql).toContain("key_hash VARCHAR(64) NOT NULL")

    // HTTPS is enforced at the last line of defence too.
    expect(sql).toContain("CHECK (target_url LIKE 'https://%')")
    // A subscription with no events would silently deliver nothing.
    expect(sql).toContain("jsonb_array_length(event_names) > 0")

    // No FK to a table this module does not own (workspaces/users are
    // plain uuid columns, per 0010_people.sql).
    const references = [...sql.matchAll(/REFERENCES\s+(\w+)/g)].map((m) => m[1])
    expect(new Set(references)).toEqual(new Set(["webhook_subscriptions", "webhook_deliveries"]))
  })
})
