import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import type {
  IntegrationConnectionRow,
  IntegrationCredentialRow,
  IntegrationWebhookEventRow,
} from "../schema/integrations"
import {
  createIntegrationCipher,
  createIntegrationsRepository,
  IntegrationCredentialCryptoError,
  maskIntegrationSecret,
  normalizeIntegrationDisplayName,
  type IntegrationSealedSecret,
} from "./integrations-repository"

const KEY = "k".repeat(64)
const OTHER_KEY = "z".repeat(64)
const WS = "11111111-1111-4111-8111-111111111111"
const CONNECTION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const MIGRATION = new URL("../../migrations/0180_integrations.sql", import.meta.url)

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

function makeConnection(
  overrides: Partial<IntegrationConnectionRow> = {},
): IntegrationConnectionRow {
  return {
    id: CONNECTION_ID,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    providerId: "acme-mail",
    displayName: "Acme Mail",
    status: "connected",
    authKind: "api_key",
    externalAccountId: null,
    config: {},
    connectedAt: null,
    disconnectedAt: null,
    lastHealthCheckAt: null,
    lastHealthStatus: null,
    lastError: null,
    lastErrorAt: null,
    ...overrides,
  }
}

function makeCredentialRow(sealed: IntegrationSealedSecret): IntegrationCredentialRow {
  return {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    connectionId: CONNECTION_ID,
    kind: "api_key",
    algorithm: sealed.algorithm,
    keyVersion: sealed.keyVersion,
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    authTag: sealed.authTag,
    hint: "sk-…4f2a",
    scopes: ["email.send"],
    expiresAt: null,
    lastUsedAt: null,
  }
}

function makeWebhookRow(
  overrides: Partial<IntegrationWebhookEventRow> = {},
): IntegrationWebhookEventRow {
  return {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    connectionId: CONNECTION_ID,
    providerId: "acme-mail",
    providerEventId: "evt_1",
    eventType: null,
    status: "received",
    payload: { hello: "world" },
    error: null,
    receivedAt: new Date("2026-01-01T00:00:00Z"),
    processedAt: null,
    ...overrides,
  }
}

describe("integrations/credential encryption", () => {
  test("two seals of the same plaintext differ (random IV, never reused)", () => {
    const cipher = createIntegrationCipher(KEY)
    const a = cipher.seal("sk-live-1234567890abcdef")
    const b = cipher.seal("sk-live-1234567890abcdef")
    expect(a.ciphertext).not.toBe(b.ciphertext)
    expect(a.iv).not.toBe(b.iv)
    expect(a.authTag).not.toBe(b.authTag)
    expect(Buffer.from(a.iv, "base64")).toHaveLength(12)
    expect(Buffer.from(a.authTag, "base64")).toHaveLength(16)
    expect(a.algorithm).toBe("aes-256-gcm")
  })

  test("decryption round-trips, including unicode", () => {
    const cipher = createIntegrationCipher(KEY)
    for (const secret of ["sk-live-1234567890abcdef", "clé-très-sécurisée-ünïcode-✓"]) {
      expect(cipher.open(cipher.seal(secret))).toBe(secret)
    }
  })

  test("the ciphertext never contains the plaintext", () => {
    const cipher = createIntegrationCipher(KEY)
    const sealed = cipher.seal("sk-live-1234567890abcdef")
    const blob = JSON.stringify(sealed)
    expect(blob).not.toContain("sk-live")
    expect(Buffer.from(sealed.ciphertext, "base64").toString("utf8")).not.toContain("sk-live")
  })

  test("a tampered ciphertext fails authentication instead of returning garbage", () => {
    const cipher = createIntegrationCipher(KEY)
    const sealed = cipher.seal("sk-live-1234567890abcdef")
    const bytes = Buffer.from(sealed.ciphertext, "base64")
    bytes[0] = (bytes[0] ?? 0) ^ 0xff
    const tampered = { ...sealed, ciphertext: bytes.toString("base64") }
    expect(() => cipher.open(tampered)).toThrow(IntegrationCredentialCryptoError)
    expect(() => cipher.open(tampered)).toThrow(/failed authentication/)
  })

  test("a tampered auth tag or IV also fails", () => {
    const cipher = createIntegrationCipher(KEY)
    const sealed = cipher.seal("sk-live-1234567890abcdef")
    const tag = Buffer.from(sealed.authTag, "base64")
    tag[0] = (tag[0] ?? 0) ^ 0xff
    expect(() => cipher.open({ ...sealed, authTag: tag.toString("base64") })).toThrow(
      IntegrationCredentialCryptoError,
    )
    const iv = Buffer.from(sealed.iv, "base64")
    iv[0] = (iv[0] ?? 0) ^ 0xff
    expect(() => cipher.open({ ...sealed, iv: iv.toString("base64") })).toThrow(
      IntegrationCredentialCryptoError,
    )
  })

  test("a different ENCRYPTION_KEY cannot open the secret", () => {
    const sealed = createIntegrationCipher(KEY).seal("sk-live-1234567890abcdef")
    expect(() => createIntegrationCipher(OTHER_KEY).open(sealed)).toThrow(
      IntegrationCredentialCryptoError,
    )
  })

  test("refuses a short key, an empty secret and an unknown algorithm", () => {
    expect(() => createIntegrationCipher("too-short")).toThrow(/at least 32 characters/)
    expect(() => createIntegrationCipher(KEY).seal("")).toThrow(/empty secret/)
    const sealed = createIntegrationCipher(KEY).seal("sk-live-1234567890abcdef")
    const bogus = { ...sealed, algorithm: "rot13" } as unknown as IntegrationSealedSecret
    expect(() => createIntegrationCipher(KEY).open(bogus)).toThrow(/unsupported credential/)
  })

  test("masking reveals a prefix and four characters, never more", () => {
    expect(maskIntegrationSecret("sk-live-1234567890abcd4f2a")).toBe("sk-…4f2a")
    expect(maskIntegrationSecret("0123456789abcdef")).toBe("01…cdef")
    expect(maskIntegrationSecret("short")).toBe("••••")
  })
})

describe("integrations/repository", () => {
  const cipher = createIntegrationCipher(KEY)

  test("putCredential seals the secret and returns metadata only", async () => {
    const repo = createIntegrationsRepository(cipher)
    const sealed = cipher.seal("sk-live-1234567890abcd4f2a")
    const db = mockDb([[], [makeCredentialRow(sealed)]])
    const metadata = await repo.putCredential(db, WS, {
      connectionId: CONNECTION_ID,
      kind: "api_key",
      secret: "sk-live-1234567890abcd4f2a",
      scopes: ["email.send"],
    })
    expect(metadata.hint).toBe("sk-…4f2a")
    expect(metadata.scopes).toEqual(["email.send"])
    expect(JSON.stringify(metadata)).not.toContain("sk-live")
    expect(Object.keys(metadata)).not.toContain("ciphertext")
    expect(Object.keys(metadata)).not.toContain("secret")
  })

  test("readCredentialSecret is the only path back to plaintext", async () => {
    const repo = createIntegrationsRepository(cipher)
    const sealed = cipher.seal("sk-live-1234567890abcd4f2a")
    const db = mockDb([[makeCredentialRow(sealed)]])
    const secret = await repo.readCredentialSecret(db, WS, CONNECTION_ID, "api_key")
    expect(secret).toBe("sk-live-1234567890abcd4f2a")
  })

  test("readCredentialSecret returns null when the slot is empty", async () => {
    const repo = createIntegrationsRepository(cipher)
    expect(await repo.readCredentialSecret(mockDb([[]]), WS, CONNECTION_ID, "api_key")).toBeNull()
  })

  test("listCredentialMetadata never leaks ciphertext", async () => {
    const repo = createIntegrationsRepository(cipher)
    const sealed = cipher.seal("sk-live-1234567890abcd4f2a")
    const rows = await repo.listCredentialMetadata(
      mockDb([[makeCredentialRow(sealed)]]),
      WS,
      CONNECTION_ID,
    )
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain(sealed.ciphertext)
    expect(JSON.stringify(rows)).not.toContain(sealed.iv)
  })

  test("createConnection normalises the display name and validates status", async () => {
    const repo = createIntegrationsRepository(cipher)
    const row = await repo.createConnection(mockDb([[makeConnection()]]), WS, {
      providerId: "acme-mail",
      displayName: "  Acme   Mail  ",
      status: "connected",
    })
    expect(row.id).toBe(CONNECTION_ID)
    await expect(
      repo.createConnection(mockDb([[makeConnection()]]), WS, {
        providerId: "acme-mail",
        displayName: "Acme",
        status: "exploded",
      }),
    ).rejects.toThrow(/status must be one of/)
  })

  test("normalizeIntegrationDisplayName rejects empty and over-long names", () => {
    expect(normalizeIntegrationDisplayName("  Acme   Mail ")).toBe("Acme Mail")
    expect(() => normalizeIntegrationDisplayName("   ")).toThrow(/must not be empty/)
    expect(() => normalizeIntegrationDisplayName("x".repeat(256))).toThrow(/at most 255/)
  })

  test("findWebhookEvent backs idempotency; markWebhookEvent stamps the outcome", async () => {
    const repo = createIntegrationsRepository(cipher)
    const existing = await repo.findWebhookEvent(
      mockDb([[makeWebhookRow()]]),
      CONNECTION_ID,
      "evt_1",
    )
    expect(existing?.providerEventId).toBe("evt_1")
    expect(await repo.findWebhookEvent(mockDb([[]]), CONNECTION_ID, "evt_2")).toBeNull()
    const marked = await repo.markWebhookEvent(
      mockDb([[makeWebhookRow({ status: "processed" })]]),
      WS,
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      "processed",
      { eventType: "message.received" },
    )
    expect(marked?.status).toBe("processed")
  })
})

describe("integrations/migration 0180", () => {
  test("creates the three module tables with their indexes", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS integration_connections")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS integration_credentials")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS integration_webhook_events")
    expect(sql).toContain("integration_connections_account_uidx")
    expect(sql).toContain("integration_credentials_slot_uidx")
    expect(sql).toContain("integration_webhook_events_idempotency_uidx")
    expect(sql).toContain("REFERENCES integration_connections (id) ON DELETE CASCADE")
  })

  test("credentials store ciphertext, iv and auth tag but no plaintext column", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const block = sql.slice(
      sql.indexOf("CREATE TABLE IF NOT EXISTS integration_credentials"),
      sql.indexOf("CREATE TABLE IF NOT EXISTS integration_webhook_events"),
    )
    expect(block).toContain("ciphertext TEXT NOT NULL")
    expect(block).toContain("iv TEXT NOT NULL")
    expect(block).toContain("auth_tag TEXT NOT NULL")
    expect(block).not.toContain("secret TEXT")
    expect(block).not.toContain("plaintext")
    expect(block).not.toContain("api_key TEXT")
  })

  test("cross-module references stay FK-free", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("workspace_id UUID NOT NULL,")
    expect(sql).not.toContain("REFERENCES workspaces")
    expect(sql).not.toContain("REFERENCES users")
    expect(sql).not.toContain("REFERENCES people")
  })
})
