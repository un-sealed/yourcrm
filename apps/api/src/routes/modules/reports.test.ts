import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import { createReportsService, type ReportsService } from "@yourcrm/crm/src/reports"
import type {
  ReportExecutionRequest,
  ReportListQuery,
  ReportListScope,
  ReportRecord,
  ReportRowScope,
  ReportsStore,
} from "@yourcrm/crm/src/reports"
import {
  describeReportObjects,
  planReportExecution,
  validateReportDefinition,
  ReportDefinitionError,
} from "@yourcrm/database/src/repositories/reports-repository"
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
import { createRoutes } from "./reports"

type StoredReport = BaseRecord & {
  name: string
  objectType: string
  visibility: string
  ownerId: string | null
  filter: unknown
  groupBy: string | null
  aggregations: unknown
  columns: unknown
  sort: unknown
  rowLimit: number
  lastRunAt: string | null
}

type TargetRow = { workspaceId: string; ownerId: string; stage: string }

function asRecord(row: StoredReport): ReportRecord {
  return row as unknown as ReportRecord
}

/**
 * Hermetic API test: the route factory takes a service, so tests inject the
 * real domain service over an in-memory store. The fake store still runs
 * the REAL planner and definition validator from `@yourcrm/database`, so
 * the allowlist and the row-scope contract are exercised without Postgres.
 */
function makeFakeService(targets: TargetRow[]) {
  const reports = createStore<StoredReport>()
  const store: ReportsStore = {
    list: async (workspaceId: string, query: ReportListQuery, scope: ReportListScope) => {
      let rows = reports.list(workspaceId)
      if (scope.kind === "visible") {
        rows = rows.filter((r) => r.visibility === "shared" || r.ownerId === scope.actorId)
      }
      const limit = query.limit ?? 25
      const data = rows.slice(0, limit)
      return {
        data: data.map(asRecord),
        pagination: {
          nextCursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null,
          limit,
        },
      }
    },
    findById: async (workspaceId, id) => {
      const row = reports.get(id, workspaceId)
      return row ? asRecord(row) : null
    },
    create: async (workspaceId, input, actorId) => {
      const error = validateReportDefinition({
        objectType: String(input.objectType ?? ""),
        groupBy: (input.groupBy as string | null) ?? null,
      })
      if (error) throw new ReportDefinitionError(error)
      return asRecord(
        reports.insert({
          ...makeBaseRecord({ workspaceId }),
          name: input.name as string,
          objectType: input.objectType as string,
          visibility: (input.visibility as string | null) ?? "shared",
          ownerId: (input.ownerId as string | null) ?? actorId ?? null,
          filter: input.filter ?? null,
          groupBy: (input.groupBy as string | null) ?? null,
          aggregations: input.aggregations ?? null,
          columns: input.columns ?? null,
          sort: input.sort ?? null,
          rowLimit: (input.rowLimit as number | null) ?? 100,
          lastRunAt: null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      )
    },
    update: async (workspaceId, id, input) => {
      const row = reports.update(id, workspaceId, input as Partial<StoredReport>)
      return row ? asRecord(row) : null
    },
    softDelete: async (workspaceId, id) => {
      reports.remove(id, workspaceId)
    },
    restore: async (workspaceId, id) => {
      reports.restore(id, workspaceId)
    },
    execute: async (
      workspaceId: string,
      request: ReportExecutionRequest,
      scope: ReportRowScope,
    ) => {
      // Real planner: proves the definition compiles to safe SQL and that
      // the scope reached the engine, without needing a database.
      const plan = planReportExecution(
        workspaceId,
        request as Parameters<typeof planReportExecution>[1],
        scope,
      )
      const visible = targets.filter(
        (row) =>
          row.workspaceId === workspaceId &&
          (scope.kind === "workspace" || row.ownerId === scope.actorId),
      )
      const counts = new Map<string, number>()
      for (const row of visible) counts.set(row.stage, (counts.get(row.stage) ?? 0) + 1)
      const rows = [...counts.entries()].map(([stage, count]) => ({ stage, count }))
      return {
        objectType: request.objectType,
        mode: plan.mode,
        scope: plan.scope,
        columns: plan.columns,
        rows,
        rowCount: rows.length,
        limit: plan.limit,
        truncated: false,
      }
    },
    markRun: async (workspaceId, id) => {
      reports.update(id, workspaceId, { lastRunAt: new Date().toISOString() })
    },
    describeObjects: () => describeReportObjects(),
  }
  return createReportsService({ store, audit: async () => undefined })
}

/** Sessions ride a tiny test-only middleware (role-accurate, no auth hook). */
function makeTestApp(session: { current: Session | null }, service: ReportsService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/reports", createRoutes({ service }))
  return app
}

const DEFINITION = {
  name: "Deals by stage",
  objectType: "deal",
  groupBy: "stage",
  aggregations: [{ fn: "count" }],
}

describe("api/reports", () => {
  let session: { current: Session | null }
  let service: ReportsService
  let ctx: ReturnType<typeof makeServiceContext>
  let targets: TargetRow[]

  beforeEach(() => {
    const owner = makeSession({ role: "owner" })
    ctx = makeServiceContext({ session: owner })
    session = { current: owner }
    targets = []
    service = makeFakeService(targets)
  })

  test("unauthenticated requests get UNAUTHORIZED", async () => {
    session.current = null
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/reports")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("list returns the cursor pagination envelope", async () => {
    await service.create(ctx, DEFINITION)
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/reports")
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("the object catalogue is served before the :id route", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/reports/objects")
    expect(res.status).toBe(200)
    const data = res.expectSuccess().data as { objectType: string }[]
    expect(data.map((o) => o.objectType)).toContain("deal")
  })

  test("get returns the definition; unknown id is NOT_FOUND", async () => {
    const created = await service.create(ctx, DEFINITION)
    const api = createApiClient({ app: makeTestApp(session, service) })
    const ok = await api.get(`/api/v1/reports/${created.id}`)
    expect(ok.status).toBe(200)
    expect((ok.expectSuccess().data as { id: string }).id).toBe(created.id)
    const missing = await api.get("/api/v1/reports/does-not-exist")
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")
  })

  test("create validates the body and returns 201", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const bad = await api.post("/api/v1/reports", { name: "  ", objectType: "deal" })
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")
    const good = await api.post("/api/v1/reports", DEFINITION)
    expect(good.status).toBe(201)
    expect((good.expectSuccess().data as { name: string }).name).toBe("Deals by stage")
  })

  test("a definition outside the allowlist is rejected with 400, not 500", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/reports", { name: "Hack", objectType: "pg_catalog" })
    expect(res.status).toBe(400)
    expect(res.expectError("VALIDATION_ERROR").error.message).toContain("unknown object type")
  })

  test("viewer create is FORBIDDEN (service denial maps to 403)", async () => {
    session.current = makeSession({ role: "viewer", workspaceId: ctx.workspaceId })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/reports", DEFINITION)
    expect(res.status).toBe(403)
    expect(res.expectError("FORBIDDEN").error.message).toContain("create")
  })

  test("update, delete and restore round-trip", async () => {
    const created = await service.create(ctx, DEFINITION)
    const api = createApiClient({ app: makeTestApp(session, service) })
    const patched = await api.patch(`/api/v1/reports/${created.id}`, { name: "Renamed" })
    expect(patched.status).toBe(200)
    const deleted = await api.delete(`/api/v1/reports/${created.id}`)
    expect(deleted.status).toBe(200)
    const gone = await api.get(`/api/v1/reports/${created.id}`)
    expect(gone.status).toBe(404)
    const restored = await api.post(`/api/v1/reports/${created.id}/restore`, {})
    expect(restored.status).toBe(200)
    expect((await api.get(`/api/v1/reports/${created.id}`)).status).toBe(200)
  })

  test("run returns the table result envelope", async () => {
    targets.push({ workspaceId: ctx.workspaceId, ownerId: ctx.actorId, stage: "won" })
    const created = await service.create(ctx, DEFINITION)
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post(`/api/v1/reports/${created.id}/run`, {})
    expect(res.status).toBe(200)
    const data = res.expectSuccess().data as {
      mode: string
      scope: string
      columns: { key: string }[]
      rows: unknown[]
    }
    expect(data.mode).toBe("grouped")
    expect(data.scope).toBe("workspace")
    expect(data.columns.map((c) => c.key)).toEqual(["stage", "count"])
    expect(data.rows).toEqual([{ stage: "won", count: 1 }])
  })

  test("run rejects an out-of-range limit override", async () => {
    const created = await service.create(ctx, DEFINITION)
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post(`/api/v1/reports/${created.id}/run`, { limit: 10_000 })
    expect(res.status).toBe(400)
    res.expectError("VALIDATION_ERROR")
  })

  /** End-to-end proof of the module's core acceptance criterion. */
  test("a lower-privileged actor gets fewer rows from the same saved report", async () => {
    const memberId = "member-user"
    targets.push(
      { workspaceId: ctx.workspaceId, ownerId: ctx.actorId, stage: "won" },
      { workspaceId: ctx.workspaceId, ownerId: "somebody-else", stage: "lost" },
      { workspaceId: ctx.workspaceId, ownerId: memberId, stage: "open" },
    )
    const created = await service.create(ctx, DEFINITION)
    const app = makeTestApp(session, service)

    const asOwner = await createApiClient({ app }).post(`/api/v1/reports/${created.id}/run`, {})
    const ownerRows = (asOwner.expectSuccess().data as { rows: unknown[]; scope: string }).rows
    expect(ownerRows).toHaveLength(3)

    session.current = makeSession({
      role: "member",
      workspaceId: ctx.workspaceId,
      userId: memberId,
    })
    const asMember = await createApiClient({ app }).post(`/api/v1/reports/${created.id}/run`, {})
    const memberData = asMember.expectSuccess().data as { rows: unknown[]; scope: string }
    expect(memberData.scope).toBe("own")
    expect(memberData.rows).toEqual([{ stage: "open", count: 1 }])

    session.current = makeSession({
      role: "viewer",
      workspaceId: ctx.workspaceId,
      userId: "nobody",
    })
    const asViewer = await createApiClient({ app }).post(`/api/v1/reports/${created.id}/run`, {})
    expect((asViewer.expectSuccess().data as { rows: unknown[] }).rows).toEqual([])
  })

  test("running someone else's private report is FORBIDDEN", async () => {
    const created = await service.create(ctx, { ...DEFINITION, visibility: "private" })
    session.current = makeSession({
      role: "member",
      workspaceId: ctx.workspaceId,
      userId: "member-user",
    })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post(`/api/v1/reports/${created.id}/run`, {})
    expect(res.status).toBe(403)
    expect(res.expectError("FORBIDDEN").error.message).toContain("private")
  })
})
