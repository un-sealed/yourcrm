import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import { appInstallations, appScopeGrants, marketplaceApps } from "../schema/marketplace"
import { createMarketplaceRepository } from "./marketplace-repository"

const MIGRATION = new URL("../../migrations/0380_marketplace.sql", import.meta.url)

/** Thenable chain stub: every query builder call returns the proxy; each await pops one result. */
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

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const WS = "11111111-1111-4111-8111-111111111111"
const INSTALLATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

function makeAppRow(overrides: Record<string, unknown> = {}) {
  return {
    id: APP_ID,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    appKey: "sample-app",
    name: "Sample App",
    version: "1.0.0",
    publisher: "Acme Inc.",
    description: null,
    status: "published",
    manifest: {},
    publisherWorkspaceId: null,
    ...overrides,
  }
}

describe("marketplace/schema", () => {
  test("marketplace_apps has no workspace_id column (deliberate — see header comment)", () => {
    const cols = marketplaceApps as unknown as Record<string, unknown>
    expect(cols.workspaceId).toBeUndefined()
    expect(cols.appKey).toBeDefined()
    expect(cols.manifest).toBeDefined()
  })

  test("app_installations and app_scope_grants carry workspace scoping", () => {
    for (const table of [appInstallations, appScopeGrants]) {
      const cols = table as unknown as Record<string, unknown>
      expect(cols.workspaceId).toBeDefined()
    }
    expect((appInstallations as unknown as Record<string, unknown>).appId).toBeDefined()
    expect((appScopeGrants as unknown as Record<string, unknown>).installationId).toBeDefined()
  })
})

describe("marketplace/repository", () => {
  test("createApp returns the inserted row", async () => {
    const repo = createMarketplaceRepository()
    const row = makeAppRow()
    const result = await repo.createApp(mockDb([[row]]), {
      appKey: "sample-app",
      name: "Sample App",
      version: "1.0.0",
      publisher: "Acme Inc.",
      manifest: {},
    })
    expect(result).toBe(row)
  })

  test("createApp surfaces empty insert results as errors", async () => {
    const repo = createMarketplaceRepository()
    await expect(
      repo.createApp(mockDb([[]]), {
        appKey: "sample-app",
        name: "Sample App",
        version: "1.0.0",
        publisher: "Acme Inc.",
        manifest: {},
      }),
    ).rejects.toThrow()
  })

  test("listApps returns the cursor pagination envelope", async () => {
    const repo = createMarketplaceRepository()
    const rows = [
      makeAppRow({ id: "id-1" }),
      makeAppRow({ id: "id-2" }),
      makeAppRow({ id: "id-3" }),
    ]
    const result = await repo.listApps(mockDb([rows]), { limit: 2 })
    expect(result.data).toHaveLength(2)
    expect(result.pagination).toEqual({ nextCursor: "id-2", limit: 2 })
  })

  test("findAppById returns null when missing", async () => {
    const repo = createMarketplaceRepository()
    await expect(repo.findAppById(mockDb([[]]), "missing")).resolves.toBeNull()
  })

  test("findActiveInstallationByApp returns null when missing", async () => {
    const repo = createMarketplaceRepository()
    await expect(repo.findActiveInstallationByApp(mockDb([[]]), WS, APP_ID)).resolves.toBeNull()
  })

  test("createGrants returns [] without touching the db when scopes is empty", async () => {
    const repo = createMarketplaceRepository()
    const result = await repo.createGrants(mockDb(), WS, INSTALLATION_ID, [])
    expect(result).toEqual([])
  })

  test("createGrants returns the inserted rows", async () => {
    const repo = createMarketplaceRepository()
    const rows = [{ id: "grant-1", object: "person", action: "read" }]
    const result = await repo.createGrants(mockDb([rows]), WS, INSTALLATION_ID, [
      { object: "person", action: "read" },
    ])
    expect(result).toBe(rows as never)
  })
})

describe("marketplace/migration", () => {
  test("0380 creates marketplace_apps, app_installations and app_scope_grants with the agreed indexes", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS marketplace_apps")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS app_installations")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS app_scope_grants")
    expect(sql).toContain("marketplace_apps_key_uidx")
    expect(sql).toContain("app_installations_workspace_app_uidx")
    expect(sql).toContain("app_scope_grants_unique_live_uidx")
    expect(sql).toContain("REFERENCES marketplace_apps (id) ON DELETE CASCADE")
    expect(sql).toContain("REFERENCES app_installations (id) ON DELETE CASCADE")
  })

  test("marketplace_apps has no workspace_id column in the DDL", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const block = sql.slice(
      sql.indexOf("CREATE TABLE IF NOT EXISTS marketplace_apps"),
      sql.indexOf("CREATE TABLE IF NOT EXISTS app_installations"),
    )
    expect(block).not.toMatch(/(?<!publisher_)\bworkspace_id\b/)
  })

  test("workspace_id, publisher_workspace_id and installed_by stay FK-free", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("publisher_workspace_id UUID")
    expect(sql).not.toContain("REFERENCES workspaces")
    expect(sql).not.toContain("REFERENCES users")
  })
})
