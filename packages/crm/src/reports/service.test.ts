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
import type { ServiceContext } from "../index"
import { createReportsService, type ReportsService } from "./index"
import type {
  ReportAuditInput,
  ReportExecutionRequest,
  ReportListQuery,
  ReportListScope,
  ReportRecord,
  ReportRowScope,
  ReportsStore,
} from "./types"

type StoredReport = BaseRecord & {
  name: string
  description: string | null
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

/** One row of the object a report reads, with its ownership columns. */
type TargetRow = {
  id: string
  workspaceId: string
  ownerId: string | null
  createdBy: string | null
  stage: string
}

function asRecord(row: StoredReport): ReportRecord {
  return row as unknown as ReportRecord
}

/**
 * Hermetic ReportsStore. `execute` deliberately honours `ReportRowScope`
 * the same way the drizzle repository does (own rows vs the whole
 * workspace) so the permission-filtering tests exercise the real contract.
 */
function makeStore() {
  const reports = createStore<StoredReport>()
  const targets: TargetRow[] = []
  const store: ReportsStore = {
    list: async (workspaceId: string, query: ReportListQuery, scope: ReportListScope) => {
      let rows = reports.list(workspaceId)
      if (query.objectType) rows = rows.filter((r) => r.objectType === query.objectType)
      if (query.visibility) rows = rows.filter((r) => r.visibility === query.visibility)
      if (query.query) {
        const needle = query.query.toLowerCase()
        rows = rows.filter((r) => r.name.toLowerCase().includes(needle))
      }
      if (scope.kind === "visible") {
        rows = rows.filter(
          (r) =>
            r.visibility === "shared" ||
            r.ownerId === scope.actorId ||
            r.createdBy === scope.actorId,
        )
      }
      const limit = Math.min(Math.max(query.limit ?? 25, 1), 200)
      const data = rows.slice(0, limit)
      return {
        data: data.map(asRecord),
        pagination: {
          nextCursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null,
          limit,
        },
      }
    },
    findById: async (workspaceId: string, id: string) => {
      const row = reports.get(id, workspaceId)
      return row ? asRecord(row) : null
    },
    create: async (workspaceId: string, input: Record<string, unknown>, actorId?: string) => {
      const row: StoredReport = {
        ...makeBaseRecord({ workspaceId }),
        name: input.name as string,
        description: (input.description as string | null) ?? null,
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
      }
      return asRecord(reports.insert(row))
    },
    update: async (workspaceId: string, id: string, input: Record<string, unknown>) => {
      const row = reports.update(id, workspaceId, input as Partial<StoredReport>)
      return row ? asRecord(row) : null
    },
    softDelete: async (workspaceId: string, id: string) => {
      reports.remove(id, workspaceId)
    },
    restore: async (workspaceId: string, id: string) => {
      reports.restore(id, workspaceId)
    },
    execute: async (
      workspaceId: string,
      request: ReportExecutionRequest,
      scope: ReportRowScope,
    ) => {
      const visible = targets.filter((row) => {
        if (row.workspaceId !== workspaceId) return false
        if (scope.kind === "workspace") return true
        return row.ownerId === scope.actorId || row.createdBy === scope.actorId
      })
      const counts = new Map<string, number>()
      for (const row of visible) counts.set(row.stage, (counts.get(row.stage) ?? 0) + 1)
      const limit = request.limit ?? 100
      const all = [...counts.entries()].map(([stage, count]) => ({ stage, count }))
      return {
        objectType: request.objectType,
        mode: "grouped" as const,
        scope: scope.kind,
        columns: [
          {
            key: "stage",
            field: "stage",
            label: "Stage",
            type: "text",
            role: "dimension" as const,
          },
          { key: "count", field: null, label: "Count", type: "number", role: "metric" as const },
        ],
        rows: all.slice(0, limit),
        rowCount: Math.min(all.length, limit),
        limit,
        truncated: all.length > limit,
      }
    },
    markRun: async (workspaceId: string, id: string) => {
      reports.update(id, workspaceId, { lastRunAt: new Date().toISOString() })
    },
    describeObjects: () => [
      {
        objectType: "deal",
        label: "Deals",
        fields: [{ name: "stage", label: "Stage", type: "text" }],
      },
    ],
  }
  return { reports, targets, store }
}

type Role = "owner" | "admin" | "member" | "viewer"

function setup(
  role: Role = "owner",
  shared?: ReturnType<typeof makeStore>,
  identity?: { workspaceId?: string; userId?: string },
) {
  const session = makeSession({
    role,
    ...(identity?.workspaceId === undefined ? {} : { workspaceId: identity.workspaceId }),
    ...(identity?.userId === undefined ? {} : { userId: identity.userId }),
  })
  const ctx = makeServiceContext({ session })
  const audits: ReportAuditInput[] = []
  const backing = shared ?? makeStore()
  const service = createReportsService({
    store: backing.store,
    audit: async (input) => void audits.push(input),
  })
  return { ctx, service, audits, session, backing }
}

async function seed(service: ReportsService, ctx: ServiceContext, overrides: object = {}) {
  return service.create(ctx, {
    name: "Deals by stage",
    objectType: "deal",
    groupBy: "stage",
    aggregations: [{ fn: "count" }],
    ...overrides,
  })
}

describe("reports/service", () => {
  test("create validates, emits report.created and audits with after", async () => {
    const { ctx, service, audits } = setup()
    const events = captureEvents()
    try {
      const report = await expectAllowed(() => seed(service, ctx))
      expect(report.name).toBe("Deals by stage")
      events.expectEmitted("report.created", {
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "report",
        entityId: report.id,
      })
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({
        workspaceId: ctx.workspaceId,
        action: "create",
        object: "report",
        recordId: report.id,
      })
      expect(audits[0]?.after).toMatchObject({ objectType: "deal" })
    } finally {
      events.release()
    }
  })

  test("create rejects invalid input before touching the store", async () => {
    const { ctx, service } = setup()
    await expect(service.create(ctx, { name: "  ", objectType: "deal" })).rejects.toThrow()
    await expect(service.create(ctx, { name: "x" })).rejects.toThrow()
    await expect(
      service.create(ctx, { name: "x", objectType: "deal", aggregations: [{ fn: "median" }] }),
    ).rejects.toThrow()
  })

  test("get returns the definition, list paginates and filters", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const found = await expectAllowed(() => service.get(ctx, created.id))
    expect(found.id).toBe(created.id)
    const listed = await expectAllowed(() => service.list(ctx, { limit: 25 }))
    expect(listed.data).toHaveLength(1)
    expect(listed.pagination).toEqual({ nextCursor: null, limit: 25 })
    const filtered = await expectAllowed(() => service.list(ctx, { objectType: "person" }))
    expect(filtered.data).toHaveLength(0)
  })

  test("get throws NOT_FOUND for unknown ids", async () => {
    const { ctx, service } = setup()
    const err = await service.get(ctx, "missing").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe("NOT_FOUND")
  })

  test("objects exposes the reportable field catalogue", async () => {
    const { ctx, service } = setup()
    const catalogue = service.objects(ctx)
    expect(catalogue[0]?.objectType).toBe("deal")
  })

  test("update emits report.updated and audits with before/after", async () => {
    const { ctx, service, audits } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      const updated = await expectAllowed(() => service.update(ctx, created.id, { name: "Won" }))
      expect(updated.name).toBe("Won")
      const emitted = events.expectEmitted("report.updated", { entityId: created.id })
      expect(emitted.before).toMatchObject({ name: "Deals by stage" })
      expect(emitted.after).toMatchObject({ name: "Won" })
      expect(audits.at(-1)).toMatchObject({ action: "update", recordId: created.id })
    } finally {
      events.release()
    }
  })

  test("softDelete hides the report and restore revives it", async () => {
    const { ctx, service, audits } = setup()
    const created = await seed(service, ctx)
    await expectAllowed(() => service.softDelete(ctx, created.id))
    await expect(service.get(ctx, created.id)).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(audits.at(-1)).toMatchObject({ action: "delete" })
    const restored = await expectAllowed(() => service.restore(ctx, created.id))
    expect(restored.id).toBe(created.id)
    expect(audits.at(-1)).toMatchObject({ action: "restore" })
    await expectAllowed(() => service.get(ctx, created.id))
  })
})

describe("reports/run", () => {
  test("run executes the saved definition, emits report.run and audits it", async () => {
    const { ctx, service, audits, backing } = setup()
    backing.targets.push(
      {
        id: "d1",
        workspaceId: ctx.workspaceId,
        ownerId: ctx.actorId,
        createdBy: ctx.actorId,
        stage: "won",
      },
      {
        id: "d2",
        workspaceId: ctx.workspaceId,
        ownerId: "other",
        createdBy: "other",
        stage: "lost",
      },
    )
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      const { result } = await expectAllowed(() => service.run(ctx, created.id))
      expect(result.mode).toBe("grouped")
      expect(result.rowCount).toBe(2)
      const emitted = events.expectEmitted("report.run", { entityId: created.id })
      expect(emitted.after).toMatchObject({ objectType: "deal", scope: "workspace", rowCount: 2 })
      expect(audits.at(-1)).toMatchObject({ action: "run", object: "report", recordId: created.id })
    } finally {
      events.release()
    }
  })

  test("run stamps lastRunAt on the definition", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    await expectAllowed(() => service.run(ctx, created.id))
    const after = await service.get(ctx, created.id)
    expect(after.lastRunAt).not.toBeNull()
  })

  test("a run may narrow the row limit but never widen the saved one", async () => {
    const { ctx, service, backing } = setup()
    for (const stage of ["a", "b", "c"]) {
      backing.targets.push({
        id: `d-${stage}`,
        workspaceId: ctx.workspaceId,
        ownerId: ctx.actorId,
        createdBy: ctx.actorId,
        stage,
      })
    }
    const created = await seed(service, ctx, { rowLimit: 2 })
    const narrowed = await service.run(ctx, created.id, { limit: 1 })
    expect(narrowed.result.limit).toBe(1)
    const widened = await service.run(ctx, created.id, { limit: 500 })
    expect(widened.result.limit).toBe(2)
    expect(widened.result.truncated).toBe(true)
  })

  test("run rejects invalid overrides", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    await expect(service.run(ctx, created.id, { limit: 0 })).rejects.toThrow()
    await expect(service.run(ctx, created.id, { limit: 10_000 })).rejects.toThrow()
  })

  test("run throws NOT_FOUND for unknown reports", async () => {
    const { ctx, service } = setup()
    await expect(service.run(ctx, "missing")).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

/**
 * The single most important property of this module: two actors running
 * the SAME saved report see different rows, because execution inherits the
 * caller's record permissions instead of being merely workspace-scoped.
 */
describe("reports/permission-filtered execution", () => {
  let backing: ReturnType<typeof makeStore>
  let workspaceId: string
  let adminCtx: ServiceContext
  let adminService: ReportsService
  let reportId: string
  const MEMBER_ID = "member-user"

  beforeEach(async () => {
    backing = makeStore()
    const admin = setup("admin", backing)
    workspaceId = admin.ctx.workspaceId
    adminCtx = admin.ctx
    adminService = admin.service
    backing.targets.push(
      {
        id: "d1",
        workspaceId,
        ownerId: adminCtx.actorId,
        createdBy: adminCtx.actorId,
        stage: "won",
      },
      { id: "d2", workspaceId, ownerId: "someone-else", createdBy: "someone-else", stage: "lost" },
      { id: "d3", workspaceId, ownerId: MEMBER_ID, createdBy: MEMBER_ID, stage: "open" },
    )
    reportId = (await seed(adminService, adminCtx)).id
  })

  test("an admin sees the whole workspace", async () => {
    const { result } = await expectAllowed(() => adminService.run(adminCtx, reportId))
    expect(result.scope).toBe("workspace")
    expect(result.rowCount).toBe(3)
  })

  test("a member running the same report sees only their own records", async () => {
    const member = setup("member", backing, { workspaceId, userId: MEMBER_ID })
    const { result } = await expectAllowed(() => member.service.run(member.ctx, reportId))
    expect(result.scope).toBe("own")
    expect(result.rowCount).toBe(1)
    expect(result.rows).toEqual([{ stage: "open", count: 1 }])
  })

  test("a viewer who owns nothing gets no rows at all", async () => {
    const viewer = setup("viewer", backing, { workspaceId, userId: "viewer-user" })
    const { result } = await expectAllowed(() => viewer.service.run(viewer.ctx, reportId))
    expect(result.scope).toBe("own")
    expect(result.rowCount).toBe(0)
    expect(result.rows).toEqual([])
  })

  test("the audit row records which scope the execution ran under", async () => {
    const member = setup("member", backing, { workspaceId, userId: MEMBER_ID })
    await member.service.run(member.ctx, reportId)
    expect(member.audits.at(-1)?.after).toMatchObject({ scope: "own", rowCount: 1 })
  })
})

describe("reports/denials", () => {
  let backing: ReturnType<typeof makeStore>
  let workspaceId: string
  let sharedId: string
  let privateId: string

  beforeEach(async () => {
    backing = makeStore()
    const owner = setup("owner", backing)
    workspaceId = owner.ctx.workspaceId
    sharedId = (await seed(owner.service, owner.ctx)).id
    privateId = (await seed(owner.service, owner.ctx, { name: "Private", visibility: "private" }))
      .id
  })

  function asRole(role: Role, userId = "other-user") {
    return setup(role, backing, { workspaceId, userId })
  }

  test("viewer cannot create", async () => {
    const { ctx, service } = asRole("viewer")
    await expectDenied(() => service.create(ctx, { name: "Nope", objectType: "deal" }))
  })

  test("viewer cannot update", async () => {
    const { ctx, service } = asRole("viewer")
    await expectDenied(() => service.update(ctx, sharedId, { name: "X" }))
  })

  test("member cannot delete (admin-only)", async () => {
    const { ctx, service } = asRole("member")
    await expectDenied(() => service.softDelete(ctx, sharedId))
  })

  test("a member cannot open someone else's private report", async () => {
    const { ctx, service } = asRole("member")
    const denied = await expectDenied(() => service.get(ctx, privateId))
    expect(denied.message).toContain("private")
  })

  test("a member cannot RUN someone else's private report", async () => {
    const { ctx, service } = asRole("member")
    await expectDenied(() => service.run(ctx, privateId))
  })

  test("private reports are hidden from other members' lists", async () => {
    const { ctx, service } = asRole("member")
    const listed = await expectAllowed(() => service.list(ctx, {}))
    expect(listed.data.map((r) => r.id)).toEqual([sharedId])
  })

  test("the private report's owner can still open and run it", async () => {
    const owner = setup("owner", backing, { workspaceId })
    const ownedId = (
      await owner.service.create(owner.ctx, {
        name: "Mine",
        objectType: "deal",
        groupBy: "stage",
        visibility: "private",
      })
    ).id
    await expectAllowed(() => owner.service.get(owner.ctx, ownedId))
    await expectAllowed(() => owner.service.run(owner.ctx, ownedId))
  })

  test("an admin may still administer other people's private reports", async () => {
    const admin = setup("admin", backing, { workspaceId, userId: "admin-user" })
    await expectAllowed(() => admin.service.get(admin.ctx, privateId))
  })

  test("viewers can list and read shared reports (read is open)", async () => {
    const { ctx, service } = asRole("viewer")
    await expectAllowed(() => service.list(ctx, {}))
    await expectAllowed(() => service.get(ctx, sharedId))
  })
})
