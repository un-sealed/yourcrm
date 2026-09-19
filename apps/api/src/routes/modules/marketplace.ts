import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  appInstallationSchema,
  appScopeGrantSchema,
  createMarketplaceService,
  installAppSchema,
  marketplaceAppQuerySchema,
  marketplaceAppSchema,
  registerAppSchema,
  type MarketplaceService,
} from "@yourcrm/crm/src/marketplace"
import { getDb, writeAudit } from "@yourcrm/database"
import { createMarketplaceRepository } from "@yourcrm/database/src/repositories/marketplace-repository"
import { getEventBus } from "@yourcrm/events"
import { PermissionDeniedError } from "@yourcrm/permissions"
import { errorEnvelope, paginatedEnvelopeSchema } from "@yourcrm/validation"
import { Hono } from "hono"
import type { Context } from "hono"
import { z } from "zod"
import type { AppEnv } from "../../hono-env"
import { requireSession } from "../../middleware/auth"
import { zodToJsonSchema } from "../../openapi/zod-to-json-schema"

/**
 * Marketplace / Plugin SDK module (spec 49-marketplace-sdk, P0).
 *
 * Catalogue browsing (`GET /marketplace/apps*`, `GET /marketplace/installations*`)
 * only needs `read` — any workspace member, including a viewer, can see what
 * is available and what is installed. Publishing (`POST /marketplace/apps`)
 * and the install/uninstall lifecycle are `admin`-level in the domain
 * service, so a member gets 403 even though the route itself has no
 * role check of its own — permissions are enforced server-side in
 * `@yourcrm/crm/src/marketplace`, never in this HTTP layer (UI hiding is
 * not a security boundary).
 */

export const basePath = "/marketplace"

const appEnvelope = z.object({ data: marketplaceAppSchema.passthrough() })
const appListEnvelope = paginatedEnvelopeSchema(marketplaceAppSchema.passthrough())
const installationEnvelope = z.object({
  data: z.object({
    installation: appInstallationSchema.passthrough(),
    grants: z.array(appScopeGrantSchema.passthrough()),
  }),
})
const installationListEnvelope = paginatedEnvelopeSchema(appInstallationSchema.passthrough())
const installResultEnvelope = z.object({
  data: z.object({
    installation: appInstallationSchema.passthrough(),
    grantedScopes: z.array(z.object({ object: z.string(), action: z.string() })),
    deniedScopes: z.array(z.object({ object: z.string(), action: z.string() })),
  }),
})

export type MarketplaceRouteDeps = {
  service?: MarketplaceService
}

function defaultService(): MarketplaceService {
  const db = getDb()
  const repository = createMarketplaceRepository()
  return createMarketplaceService({
    apps: {
      list: (query) => repository.listApps(db, query),
      findById: (id) => repository.findAppById(db, id),
      findByAppKey: (appKey) => repository.findAppByKey(db, appKey),
      create: (input, actorId) =>
        repository.createApp(
          db,
          {
            appKey: String(input.appKey),
            name: String(input.name),
            version: String(input.version),
            publisher: String(input.publisher),
            description: (input.description as string | null | undefined) ?? null,
            status: input.status as string | undefined,
            manifest: input.manifest as Record<string, unknown>,
            publisherWorkspaceId: input.publisherWorkspaceId as string | null | undefined,
          },
          actorId,
        ),
    },
    installations: {
      list: (workspaceId, query) => repository.listInstallations(db, { workspaceId, ...query }),
      findById: (workspaceId, id) => repository.findInstallationById(db, workspaceId, id),
      findActiveByApp: (workspaceId, appId) =>
        repository.findActiveInstallationByApp(db, workspaceId, appId),
      create: (workspaceId, input, actorId) =>
        repository.createInstallation(db, workspaceId, input, actorId),
      uninstall: async (workspaceId, id, actorId) => {
        await repository.uninstallInstallation(db, workspaceId, id, actorId)
      },
    },
    grants: {
      listByInstallation: (workspaceId, installationId) =>
        repository.listGrants(db, workspaceId, installationId),
      createMany: (workspaceId, installationId, scopes, actorId) =>
        repository.createGrants(db, workspaceId, installationId, scopes, actorId),
      revokeAll: async (workspaceId, installationId, actorId) => {
        await repository.revokeGrants(db, workspaceId, installationId, actorId)
      },
    },
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "user" })
    },
    events: getEventBus(),
  })
}

function serviceContextOf(c: Context<AppEnv>) {
  const session = c.get("session") as Session | null
  return {
    workspaceId: session?.workspaceId ?? "",
    actorId: session?.user.id ?? "",
    role: session ? roleInWorkspace(session) : "viewer",
    correlationId: c.get("requestId") as string | undefined,
  }
}

const STATUS_BY_CODE: Record<string, 400 | 403 | 404 | 409> = {
  NOT_FOUND: 404,
  CONFLICT: 409,
}

function mapError(c: Context<AppEnv>, err: unknown) {
  const requestId = c.get("requestId") as string | undefined
  if (err instanceof PermissionDeniedError) {
    return c.json(errorEnvelope("FORBIDDEN", err.message, requestId), 403)
  }
  if (err instanceof z.ZodError) {
    return c.json(
      errorEnvelope("VALIDATION_ERROR", "Invalid request body", requestId, err.flatten()),
      400,
    )
  }
  if (err instanceof Error) {
    const code = (err as { code?: string }).code
    const status = code ? STATUS_BY_CODE[code] : undefined
    if (code && status) return c.json(errorEnvelope(code, err.message, requestId), status)
  }
  throw err
}

function invalidBody(c: Context, details: unknown, what = "Invalid request body") {
  return c.json(
    errorEnvelope("VALIDATION_ERROR", what, c.req.header("x-request-id") ?? undefined, details),
    400,
  )
}

export function createRoutes(deps: MarketplaceRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  let cached: MarketplaceService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  app.get(
    "/apps",
    requireSession(),
    zValidator("query", marketplaceAppQuerySchema, (result, c) => {
      if (!result.success) return invalidBody(c, result.error.flatten(), "Invalid query parameters")
    }),
    async (c) => {
      try {
        return c.json(await service().listApps(serviceContextOf(c), c.req.valid("query")))
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post(
    "/apps",
    requireSession(),
    zValidator("json", registerAppSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result.error.flatten())
    }),
    async (c) => {
      try {
        const registered = await service().registerApp(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: registered }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/apps/:id", requireSession(), async (c) => {
    try {
      return c.json({ data: await service().getApp(serviceContextOf(c), c.req.param("id")) })
    } catch (err) {
      return mapError(c, err)
    }
  })

  /** Explicit-consent install: body is empty today, reserved for future per-scope opt-out. */
  app.post(
    "/apps/:id/install",
    requireSession(),
    zValidator("json", installAppSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result.error.flatten())
    }),
    async (c) => {
      try {
        const result = await service().install(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: result }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get(
    "/installations",
    requireSession(),
    zValidator(
      "query",
      marketplaceAppQuerySchema.pick({ limit: true, cursor: true, order: true }),
      (result, c) => {
        if (!result.success) {
          return invalidBody(c, result.error.flatten(), "Invalid query parameters")
        }
      },
    ),
    async (c) => {
      try {
        return c.json(await service().listInstallations(serviceContextOf(c), c.req.valid("query")))
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/installations/:id", requireSession(), async (c) => {
    try {
      return c.json({
        data: await service().getInstallation(serviceContextOf(c), c.req.param("id")),
      })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.delete("/installations/:id", requireSession(), async (c) => {
    try {
      await service().uninstall(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: { uninstalled: true } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  return app
}

export const openApiPaths = {
  "/api/v1/marketplace/apps": {
    get: { summary: "Browse the app catalogue (read)", operationId: "listMarketplaceApps" },
    post: {
      summary: "Publish an app manifest to the catalogue (admin)",
      operationId: "registerMarketplaceApp",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(registerAppSchema) } },
      },
    },
  },
  "/api/v1/marketplace/apps/{id}": {
    get: { summary: "Get one catalogue app (read)", operationId: "getMarketplaceApp" },
  },
  "/api/v1/marketplace/apps/{id}/install": {
    post: {
      summary:
        "Install an app into this workspace (admin). Grants are capped by BOTH the manifest's requested scopes and the installer's own permissions.",
      operationId: "installMarketplaceApp",
    },
  },
  "/api/v1/marketplace/installations": {
    get: {
      summary: "List this workspace's installed apps (read)",
      operationId: "listAppInstallations",
    },
  },
  "/api/v1/marketplace/installations/{id}": {
    get: {
      summary: "Get one installation with its live scope grants (read)",
      operationId: "getAppInstallation",
    },
    delete: {
      summary: "Uninstall — revokes every grant, leaves no orphaned access (admin)",
      operationId: "uninstallMarketplaceApp",
    },
  },
}

export {
  appEnvelope,
  appListEnvelope,
  installationEnvelope,
  installationListEnvelope,
  installResultEnvelope,
}
