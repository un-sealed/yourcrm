import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  createOverviewService,
  overviewSchema,
  type OverviewService,
  type OverviewStore,
} from "@yourcrm/crm/src/overview"
import { getDb, type Database } from "@yourcrm/database"
import { createOverviewRepository } from "@yourcrm/database/src/repositories/overview-repository"
import { PermissionDeniedError } from "@yourcrm/permissions"
import { errorEnvelope } from "@yourcrm/validation"
import { Hono } from "hono"
import type { Context } from "hono"
import { z } from "zod"
import type { AppEnv } from "../../hono-env"
import { requireSession } from "../../middleware/auth"

/**
 * Overview module — feeds the redesigned home dashboard (P0).
 *
 * Thin HTTP layer only: session from the auth middleware, straight into the
 * domain service. Read-only, no query params: `GET /api/v1/overview`
 * returns one payload computed live from the caller's workspace — there is
 * no body to validate and nothing for a caller to assert (see
 * `packages/crm/src/overview/service.ts`).
 */

export const basePath = "/overview"

const overviewEnvelope = z.object({ data: overviewSchema })

export type OverviewRouteDeps = {
  service?: OverviewService
}

/** Adapts the drizzle repository to the `OverviewStore` port. */
function defaultStore(db: Database): OverviewStore {
  const repository = createOverviewRepository()
  return {
    getOverview: (workspaceId, now) => repository.getOverview(db, workspaceId, now),
  }
}

function defaultService(): OverviewService {
  const db = getDb()
  return createOverviewService({ store: defaultStore(db) })
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

function mapError(c: Context<AppEnv>, err: unknown) {
  const requestId = c.get("requestId") as string | undefined
  if (err instanceof PermissionDeniedError) {
    return c.json(errorEnvelope("FORBIDDEN", err.message, requestId), 403)
  }
  throw err
}

export function createRoutes(deps: OverviewRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  let cached: OverviewService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  app.get("/", requireSession(), async (c) => {
    try {
      const overview = await service().getOverview(serviceContextOf(c))
      return c.json({ data: overview })
    } catch (err) {
      return mapError(c, err)
    }
  })

  return app
}

export const openApiPaths = {
  "/api/v1/overview": {
    get: {
      summary: "Home dashboard overview: KPIs, trend, activity and recent deals",
      operationId: "getOverview",
    },
  },
}

export { overviewEnvelope }
