import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import {
  createMarketplaceService,
  type AppInstallation,
  type AppScopeGrant,
  type MarketplaceApp,
  type MarketplaceService,
} from "@yourcrm/crm/src/marketplace"
import {
  createApiClient,
  createStore,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes } from "./marketplace"

type StoredInstallation = BaseRecord & {
  appId: string
  appVersion: string
  status: string
  installedBy: string | null
}
type StoredGrant = BaseRecord & { installationId: string; object: string; action: string }

const MANIFEST = {
  id: "sample-app",
  name: "Sample App",
  version: "1.0.0",
  publisher: "Acme Inc.",
  scopes: ["person:read", "person:delete"],
  webhooks: [],
  uiExtensionPoints: [],
}

/** Real domain service over hermetic in-memory stores (same shape as service.test.ts). */
function makeFakeService(): MarketplaceService {
  const apps = new Map<string, MarketplaceApp>()
  const installations = createStore<StoredInstallation>()
  const grants = createStore<StoredGrant>()
  let seq = 0

  return createMarketplaceService({
    apps: {
      list: async (query) => {
        let rows = [...apps.values()]
        if (query.status) rows = rows.filter((a) => a.status === query.status)
        return { data: rows, pagination: { nextCursor: null, limit: 25 } }
      },
      findById: async (id) => apps.get(id) ?? null,
      findByAppKey: async (appKey) => [...apps.values()].find((a) => a.appKey === appKey) ?? null,
      create: async (input, actorId) => {
        seq += 1
        const app: MarketplaceApp = {
          id: `app_${seq}`,
          appKey: input.appKey as string,
          name: input.name as string,
          version: input.version as string,
          publisher: input.publisher as string,
          status: (input.status as string) ?? "published",
          manifest: input.manifest as Record<string, unknown>,
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        }
        apps.set(app.id, app)
        return app
      },
    },
    installations: {
      list: async (workspaceId) => ({
        data: installations.list(workspaceId) as unknown as AppInstallation[],
        pagination: { nextCursor: null, limit: 25 },
      }),
      findById: async (workspaceId, id) =>
        installations.get(id, workspaceId) as unknown as AppInstallation | null,
      findActiveByApp: async (workspaceId, appId) => {
        const row = installations
          .list(workspaceId)
          .find((r) => r.appId === appId && r.status === "active")
        return (row as unknown as AppInstallation | undefined) ?? null
      },
      create: async (workspaceId, input, actorId) => {
        const record: StoredInstallation = {
          ...makeBaseRecord({ workspaceId }),
          appId: input.appId,
          appVersion: input.appVersion,
          status: "active",
          installedBy: input.installedBy ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }
        return installations.insert(record) as unknown as AppInstallation
      },
      uninstall: async (workspaceId, id) => {
        installations.remove(id, workspaceId)
      },
    },
    grants: {
      listByInstallation: async (workspaceId, installationId) =>
        grants
          .list(workspaceId)
          .filter((g) => g.installationId === installationId) as unknown as AppScopeGrant[],
      createMany: async (workspaceId, installationId, scopes, actorId) =>
        scopes.map((scope) =>
          grants.insert({
            ...makeBaseRecord({ workspaceId }),
            installationId,
            object: scope.object,
            action: scope.action,
            ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
          }),
        ) as unknown as AppScopeGrant[],
      revokeAll: async (workspaceId, installationId) => {
        for (const grant of grants.list(workspaceId)) {
          if (grant.installationId === installationId) grants.remove(grant.id, workspaceId)
        }
      },
    },
    audit: async () => undefined,
  })
}

/**
 * Hermetic API test: the route factory takes a service, so tests inject the
 * real domain service over in-memory stores. Sessions ride a tiny test-only
 * middleware (role-accurate without touching the foundation auth hook).
 */
function makeTestApp(session: { current: Session | null }, service: MarketplaceService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/marketplace", createRoutes({ service }))
  return app
}

describe("api/marketplace", () => {
  let session: { current: Session | null }
  let service: MarketplaceService
  let ctx: ReturnType<typeof makeServiceContext>

  beforeEach(() => {
    const owner = makeSession({ role: "owner" })
    ctx = makeServiceContext({ session: owner })
    session = { current: owner }
    service = makeFakeService()
  })

  test("unauthenticated requests get UNAUTHORIZED", async () => {
    session.current = null
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/marketplace/apps")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("viewer can browse the catalogue (read is open)", async () => {
    await service.registerApp(ctx, { manifest: MANIFEST })
    session.current = makeSession({ role: "viewer", workspaceId: ctx.workspaceId })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/marketplace/apps")
    expect(res.status).toBe(200)
    expect(res.expectSuccess().data).toHaveLength(1)
  })

  test("member cannot register an app (admin-only, maps to 403)", async () => {
    session.current = makeSession({ role: "member", workspaceId: ctx.workspaceId })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/marketplace/apps", { manifest: MANIFEST })
    expect(res.status).toBe(403)
    res.expectError("FORBIDDEN")
  })

  test("register validates the manifest and returns 201", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const bad = await api.post("/api/v1/marketplace/apps", {
      manifest: { ...MANIFEST, scopes: ["not-a-scope"] },
    })
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")

    const good = await api.post("/api/v1/marketplace/apps", { manifest: MANIFEST })
    expect(good.status).toBe(201)
    expect((good.expectSuccess().data as { appKey: string }).appKey).toBe("sample-app")
  })

  test("install/uninstall round-trip: PROPERTY — uninstall leaves no grant behind", async () => {
    const app = await service.registerApp(ctx, { manifest: MANIFEST })
    const api = createApiClient({ app: makeTestApp(session, service) })

    const installed = await api.post(`/api/v1/marketplace/apps/${app.id}/install`)
    expect(installed.status).toBe(201)
    const body = installed.expectSuccess().data as {
      installation: { id: string }
      grantedScopes: unknown[]
    }
    expect(body.grantedScopes).toHaveLength(2)

    const detail = await api.get(`/api/v1/marketplace/installations/${body.installation.id}`)
    expect(detail.status).toBe(200)
    expect((detail.expectSuccess().data as { grants: unknown[] }).grants).toHaveLength(2)

    const uninstalled = await api.delete(
      `/api/v1/marketplace/installations/${body.installation.id}`,
    )
    expect(uninstalled.status).toBe(200)

    const gone = await api.get(`/api/v1/marketplace/installations/${body.installation.id}`)
    expect(gone.status).toBe(404)
  })

  test("member cannot install (admin-only, maps to 403)", async () => {
    const app = await service.registerApp(ctx, { manifest: MANIFEST })
    session.current = makeSession({ role: "member", workspaceId: ctx.workspaceId })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post(`/api/v1/marketplace/apps/${app.id}/install`)
    expect(res.status).toBe(403)
    res.expectError("FORBIDDEN")
  })

  test("installing an unknown app is NOT_FOUND", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/marketplace/apps/does-not-exist/install")
    expect(res.status).toBe(404)
    res.expectError("NOT_FOUND")
  })
})
