import { beforeEach, describe, expect, test } from "bun:test"
import {
  captureEvents,
  createStore,
  expectAllowed,
  expectDenied,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { PermissionDeniedError } from "@yourcrm/permissions"
import { createMarketplaceService } from "./index"
import type {
  AppInstallation,
  AppManifest,
  AppScopeGrant,
  MarketplaceApp,
  MarketplaceAuditInput,
} from "./types"

type StoredApp = MarketplaceApp & { createdAt: string }
type StoredInstallation = BaseRecord & {
  appId: string
  appVersion: string
  status: string
  installedBy: string | null
}
type StoredGrant = BaseRecord & { installationId: string; object: string; action: string }

const SAMPLE_MANIFEST: AppManifest = {
  id: "sample-app",
  name: "Sample App",
  version: "1.0.0",
  publisher: "Acme Inc.",
  description: "A sample app for tests.",
  scopes: ["person:read", "person:delete"],
  webhooks: [],
  uiExtensionPoints: [],
}

let appSeq = 0

/** Hermetic in-memory stores backing the three service ports. */
function makeStores() {
  const apps = new Map<string, StoredApp>()
  const installations = createStore<StoredInstallation>()
  const grants = createStore<StoredGrant>()

  function seedApp(overrides: Partial<StoredApp> = {}): StoredApp {
    appSeq += 1
    const manifest = (overrides.manifest as AppManifest | undefined) ?? SAMPLE_MANIFEST
    const app: StoredApp = {
      id: `app_${appSeq}`,
      appKey: manifest.id,
      name: manifest.name,
      version: manifest.version,
      publisher: manifest.publisher,
      status: "published",
      manifest: manifest as unknown as Record<string, unknown>,
      createdAt: new Date().toISOString(),
      ...overrides,
    }
    apps.set(app.id, app)
    return app
  }

  return {
    apps,
    installations,
    grants,
    seedApp,
    ports: {
      apps: {
        list: async (query: { status?: string }) => {
          let rows = [...apps.values()]
          if (query.status) rows = rows.filter((a) => a.status === query.status)
          return { data: rows, pagination: { nextCursor: null, limit: 25 } }
        },
        findById: async (id: string) => apps.get(id) ?? null,
        findByAppKey: async (appKey: string) =>
          [...apps.values()].find((a) => a.appKey === appKey) ?? null,
        create: async (input: Record<string, unknown>, actorId?: string) => {
          appSeq += 1
          const app: StoredApp = {
            id: `app_${appSeq}`,
            appKey: input.appKey as string,
            name: input.name as string,
            version: input.version as string,
            publisher: input.publisher as string,
            status: (input.status as string) ?? "published",
            manifest: input.manifest as Record<string, unknown>,
            createdAt: new Date().toISOString(),
            ...(actorId === undefined ? {} : { createdBy: actorId }),
          }
          apps.set(app.id, app)
          return app
        },
      },
      installations: {
        list: async (workspaceId: string) => ({
          data: installations.list(workspaceId) as unknown as AppInstallation[],
          pagination: { nextCursor: null, limit: 25 },
        }),
        findById: async (workspaceId: string, id: string) =>
          installations.get(id, workspaceId) as unknown as AppInstallation | null,
        findActiveByApp: async (workspaceId: string, appId: string) => {
          const row = installations
            .list(workspaceId)
            .find((r) => r.appId === appId && r.status === "active")
          return (row as unknown as AppInstallation | undefined) ?? null
        },
        create: async (
          workspaceId: string,
          input: { appId: string; appVersion: string; installedBy?: string | null },
          actorId?: string,
        ) => {
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
        uninstall: async (workspaceId: string, id: string) => {
          installations.update(id, workspaceId, { status: "uninstalled" } as never)
          installations.remove(id, workspaceId)
        },
      },
      grants: {
        listByInstallation: async (workspaceId: string, installationId: string) =>
          grants
            .list(workspaceId)
            .filter((g) => g.installationId === installationId) as unknown as AppScopeGrant[],
        createMany: async (
          workspaceId: string,
          installationId: string,
          scopes: readonly { object: string; action: string }[],
          actorId?: string,
        ) =>
          scopes.map((scope) =>
            grants.insert({
              ...makeBaseRecord({ workspaceId }),
              installationId,
              object: scope.object,
              action: scope.action,
              ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
            }),
          ) as unknown as AppScopeGrant[],
        revokeAll: async (workspaceId: string, installationId: string) => {
          for (const grant of grants.list(workspaceId)) {
            if (grant.installationId === installationId) grants.remove(grant.id, workspaceId)
          }
        },
      },
    },
  }
}

function setup(
  role: "owner" | "admin" | "member" | "viewer" = "owner",
  shared?: ReturnType<typeof makeStores>,
  workspaceId?: string,
) {
  const session = makeSession({ role, ...(workspaceId === undefined ? {} : { workspaceId }) })
  const ctx = makeServiceContext({ session })
  const audits: MarketplaceAuditInput[] = []
  const backing = shared ?? makeStores()
  const service = createMarketplaceService({
    apps: backing.ports.apps,
    installations: backing.ports.installations,
    grants: backing.ports.grants,
    audit: async (input) => void audits.push(input),
  })
  return { ctx, service, audits, session, backing }
}

describe("marketplace/service", () => {
  describe("registerApp", () => {
    test("validates the manifest and persists it", async () => {
      const { ctx, service } = setup("admin")
      const app = await expectAllowed(() => service.registerApp(ctx, { manifest: SAMPLE_MANIFEST }))
      expect(app.appKey).toBe("sample-app")
      expect(app.status).toBe("published")
    })

    test("rejects a manifest with an invalid scope string", async () => {
      const { ctx, service } = setup("admin")
      await expect(
        service.registerApp(ctx, {
          manifest: { ...SAMPLE_MANIFEST, scopes: ["not-a-scope"] },
        }),
      ).rejects.toThrow()
    })

    test("rejects a duplicate app id", async () => {
      const { ctx, service, backing } = setup("admin")
      await expectAllowed(() => service.registerApp(ctx, { manifest: SAMPLE_MANIFEST }))
      await expect(
        service.registerApp(
          makeServiceContext({
            session: makeSession({ role: "admin", workspaceId: ctx.workspaceId }),
          }),
          { manifest: SAMPLE_MANIFEST },
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" })
      expect(backing.apps.size).toBe(1)
    })

    test("member cannot register an app (admin-only)", async () => {
      const { ctx, service } = setup("member")
      await expectDenied(() => service.registerApp(ctx, { manifest: SAMPLE_MANIFEST }))
    })
  })

  describe("install / scope grants", () => {
    let backing: ReturnType<typeof makeStores>
    let workspaceId: string
    let appId: string

    beforeEach(async () => {
      backing = makeStores()
      const owner = setup("owner", backing)
      workspaceId = owner.ctx.workspaceId
      const app = await expectAllowed(() =>
        owner.service.registerApp(owner.ctx, { manifest: SAMPLE_MANIFEST }),
      )
      appId = app.id
    })

    test("owner installing grants every requested scope, emits app.installed, audits", async () => {
      const { ctx, service, audits } = setup("owner", backing, workspaceId)
      const events = captureEvents()
      try {
        const result = await expectAllowed(() => service.install(ctx, appId))
        expect(result.grantedScopes).toEqual([
          { object: "person", action: "read" },
          { object: "person", action: "delete" },
        ])
        expect(result.deniedScopes).toEqual([])
        events.expectEmitted("app.installed", {
          workspaceId: ctx.workspaceId,
          entityType: "app_installation",
          entityId: result.installation.id,
        })
        expect(audits.some((a) => a.action === "install")).toBe(true)
      } finally {
        events.release()
      }
    })

    // NOTE on "PROPERTY 2" (capping granted scopes to the installer's own
    // permissions): install/uninstall are gated `admin`-level (rank 80) per
    // the module spec, and every `PERMISSION_ACTION` tops out at rank 80
    // too (admin/delete/run_automation all tie) — so any actor who clears
    // the install gate already clears every individual scope's rank
    // requirement, and end-to-end there is no role that reaches
    // `service.install()` but gets capped. The capping logic itself
    // (`partitionScopesByInstallerPermission`) is exercised directly, with
    // a `viewer` role exactly as the property describes, in
    // `access.test.ts`. `service.install()` here only proves it USES that
    // function and persists exactly its output.

    test("install persists exactly what partitionScopesByInstallerPermission grants", async () => {
      const { ctx, service } = setup("owner", backing, workspaceId)
      const result = await expectAllowed(() => service.install(ctx, appId))
      expect(result.grantedScopes).toEqual([
        { object: "person", action: "read" },
        { object: "person", action: "delete" },
      ])
      const grants = await backing.ports.grants.listByInstallation(
        workspaceId,
        result.installation.id,
      )
      expect(grants.map((g) => `${g.object}:${g.action}`).sort()).toEqual([
        "person:delete",
        "person:read",
      ])
    })

    test("PROPERTY: an app cannot act outside its granted scopes", async () => {
      const { ctx, service } = setup("owner", backing, workspaceId)
      const result = await expectAllowed(() => service.install(ctx, appId))

      // A scope never requested at all (not in the manifest) is denied.
      const err = await service
        .assertScope(ctx, result.installation.id, "deal", "update")
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PermissionDeniedError)

      // Granted scopes are allowed.
      await expect(
        service.assertScope(ctx, result.installation.id, "person", "read"),
      ).resolves.toBeUndefined()
      await expect(
        service.assertScope(ctx, result.installation.id, "person", "delete"),
      ).resolves.toBeUndefined()
    })

    test("cannot install the same app twice in one workspace", async () => {
      const { ctx, service } = setup("owner", backing, workspaceId)
      await expectAllowed(() => service.install(ctx, appId))
      await expect(service.install(ctx, appId)).rejects.toMatchObject({ code: "CONFLICT" })
    })

    test("member cannot install (admin-only)", async () => {
      const { ctx, service } = setup("member", backing, workspaceId)
      // NOTE: role rank for "member" (40) < required "admin" action (80).
      await expectDenied(() => service.install(ctx, appId))
    })
  })

  describe("uninstall", () => {
    let backing: ReturnType<typeof makeStores>
    let workspaceId: string
    let installationId: string

    beforeEach(async () => {
      backing = makeStores()
      const owner = setup("owner", backing)
      workspaceId = owner.ctx.workspaceId
      const app = await expectAllowed(() =>
        owner.service.registerApp(owner.ctx, { manifest: SAMPLE_MANIFEST }),
      )
      const result = await expectAllowed(() => owner.service.install(owner.ctx, app.id))
      installationId = result.installation.id
    })

    test("PROPERTY: uninstall revokes every grant — none survive", async () => {
      const before = await backing.ports.grants.listByInstallation(workspaceId, installationId)
      expect(before.length).toBeGreaterThan(0)

      const { ctx, service, audits } = setup("owner", backing, workspaceId)
      const events = captureEvents()
      try {
        await expectAllowed(() => service.uninstall(ctx, installationId))
        events.expectEmitted("app.uninstalled", { entityId: installationId })
        expect(audits.some((a) => a.action === "uninstall")).toBe(true)
      } finally {
        events.release()
      }

      const after = await backing.ports.grants.listByInstallation(workspaceId, installationId)
      expect(after).toEqual([])

      // The scope gate must deny even the previously-granted scope now.
      const err = await service
        .assertScope(ctx, installationId, "person", "read")
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Error)
    })

    test("member cannot uninstall (admin-only)", async () => {
      const { ctx, service } = setup("member", backing, workspaceId)
      await expectDenied(() => service.uninstall(ctx, installationId))
    })

    test("uninstalling twice reports not found the second time", async () => {
      const { ctx, service } = setup("owner", backing, workspaceId)
      await expectAllowed(() => service.uninstall(ctx, installationId))
      const err = await service.uninstall(ctx, installationId).catch((e: unknown) => e)
      expect((err as { code?: string }).code).toBe("NOT_FOUND")
    })
  })

  describe("reads", () => {
    test("viewer can list and get apps (read is open)", async () => {
      const backing = makeStores()
      const owner = setup("owner", backing)
      const app = await expectAllowed(() =>
        owner.service.registerApp(owner.ctx, { manifest: SAMPLE_MANIFEST }),
      )
      const { ctx, service } = setup("viewer", backing, owner.ctx.workspaceId)
      await expectAllowed(() => service.listApps(ctx, {}))
      await expectAllowed(() => service.getApp(ctx, app.id))
    })

    test("getApp throws NOT_FOUND for unknown ids", async () => {
      const { ctx, service } = setup()
      const err = await service.getApp(ctx, "missing").catch((e: unknown) => e)
      expect((err as { code?: string }).code).toBe("NOT_FOUND")
    })
  })
})
