import { beforeEach, describe, expect, test } from "bun:test"
import type { ServiceContext } from "../index"
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
import {
  createImportExportService,
  type ExportJobRecord,
  type ImportExportService,
  type ImportJobRecord,
} from "./index"
import type {
  ExportJobListQuery,
  ImportExportAuditInput,
  ImportJobListQuery,
} from "./types"

type StoredImport = BaseRecord & {
  objectType: string
  status: string
  mode: string
  format: string
  fileName: string | null
  mapping: Record<string, string> | null
  totalRows: number
  processedRows: number
  succeededRows: number
  failedRows: number
  skippedRows: number
  dryRun: boolean
}

type StoredExport = BaseRecord & {
  objectType: string
  status: string
  format: string
  fileName: string | null
  totalRows: number
}

function asImport(row: StoredImport): ImportJobRecord {
  return row as unknown as ImportJobRecord
}

function asExport(row: StoredExport): ExportJobRecord {
  return row as unknown as ExportJobRecord
}

/** Hermetic ImportExportStore port backed by the shared in-memory stores. */
function makeStore() {
  const imports = createStore<StoredImport>()
  const exports = createStore<StoredExport>()
  return {
    imports,
    exports,
    store: {
      listImports: async (workspaceId: string, query: ImportJobListQuery) => {
        let rows = imports.list(workspaceId)
        if (query.objectType) rows = rows.filter((r) => r.objectType === query.objectType)
        if (query.status) rows = rows.filter((r) => r.status === query.status)
        if (query.query) {
          const q = query.query.toLowerCase()
          rows = rows.filter((r) => `${r.objectType} ${r.fileName ?? ""}`.toLowerCase().includes(q))
        }
        const limit = Math.min(Math.max(query.limit ?? 25, 1), 200)
        const data = rows.slice(0, limit)
        return {
          data: data.map(asImport),
          pagination: {
            nextCursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null,
            limit,
          },
        }
      },
      findImportById: async (workspaceId: string, id: string) => {
        const row = imports.get(id, workspaceId)
        return row ? asImport(row) : null
      },
      createImport: async (workspaceId: string, input: Record<string, unknown>) => {
        const record: StoredImport = {
          ...makeBaseRecord({ workspaceId }),
          objectType: input.objectType as string,
          status: "pending",
          mode: (input.mode as string | null) ?? "create",
          format: "csv",
          fileName: (input.fileName as string | null) ?? null,
          mapping: (input.mapping as Record<string, string> | null) ?? null,
          totalRows: (input.totalRows as number | null) ?? 0,
          processedRows: 0,
          succeededRows: 0,
          failedRows: 0,
          skippedRows: 0,
          dryRun: (input.dryRun as boolean | null) ?? false,
        }
        return asImport(imports.insert(record))
      },
      updateImport: async (workspaceId: string, id: string, input: Record<string, unknown>) => {
        const row = imports.update(id, workspaceId, input as Partial<StoredImport>)
        return row ? asImport(row) : null
      },
      softDeleteImport: async (workspaceId: string, id: string) => {
        imports.remove(id, workspaceId)
      },
      restoreImport: async (workspaceId: string, id: string) => {
        imports.restore(id, workspaceId)
      },
      listExports: async (workspaceId: string, query: ExportJobListQuery) => {
        let rows = exports.list(workspaceId)
        if (query.objectType) rows = rows.filter((r) => r.objectType === query.objectType)
        if (query.status) rows = rows.filter((r) => r.status === query.status)
        const limit = Math.min(Math.max(query.limit ?? 25, 1), 200)
        const data = rows.slice(0, limit)
        return {
          data: data.map(asExport),
          pagination: {
            nextCursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null,
            limit,
          },
        }
      },
      findExportById: async (workspaceId: string, id: string) => {
        const row = exports.get(id, workspaceId)
        return row ? asExport(row) : null
      },
      createExport: async (workspaceId: string, input: Record<string, unknown>) => {
        const record: StoredExport = {
          ...makeBaseRecord({ workspaceId }),
          objectType: input.objectType as string,
          status: "pending",
          format: "csv",
          fileName: (input.fileName as string | null) ?? null,
          totalRows: (input.totalRows as number | null) ?? 0,
        }
        return asExport(exports.insert(record))
      },
      updateExport: async (workspaceId: string, id: string, input: Record<string, unknown>) => {
        const row = exports.update(id, workspaceId, input as Partial<StoredExport>)
        return row ? asExport(row) : null
      },
      softDeleteExport: async (workspaceId: string, id: string) => {
        exports.remove(id, workspaceId)
      },
      restoreExport: async (workspaceId: string, id: string) => {
        exports.restore(id, workspaceId)
      },
    },
  }
}

function setup(
  role: "owner" | "admin" | "member" | "viewer" = "owner",
  shared?: ReturnType<typeof makeStore>,
  workspaceId?: string,
) {
  const session = makeSession({ role, ...(workspaceId === undefined ? {} : { workspaceId }) })
  const ctx = makeServiceContext({ session })
  const audits: ImportExportAuditInput[] = []
  const backing = shared ?? makeStore()
  const service = createImportExportService({
    store: backing.store,
    audit: async (input) => void audits.push(input),
  })
  return { ctx, service, audits, session, backing }
}

async function seedImport(service: ImportExportService, ctx: ServiceContext, objectType = "person") {
  return service.createImport(ctx, { objectType })
}

async function seedExport(service: ImportExportService, ctx: ServiceContext, objectType = "person") {
  return service.createExport(ctx, { objectType })
}

describe("import-export/service", () => {
  test("createImport validates, emits import.started and audits with after", async () => {
    const { ctx, service, audits } = setup()
    const events = captureEvents()
    try {
      const job = await expectAllowed(() => service.createImport(ctx, { objectType: "person" }))
      expect(job.objectType).toBe("person")
      events.expectEmitted("import.started", {
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "import_job",
        entityId: job.id,
      })
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({
        workspaceId: ctx.workspaceId,
        action: "create",
        object: "import_job",
        recordId: job.id,
      })
      expect(audits[0]?.after).toMatchObject({ objectType: "person" })
    } finally {
      events.release()
    }
  })

  test("createImport rejects invalid input before touching the store", async () => {
    const { ctx, service } = setup()
    await expect(service.createImport(ctx, { objectType: "  " })).rejects.toThrow()
  })

  test("getImport returns the job, listImports paginates", async () => {
    const { ctx, service } = setup()
    const created = await seedImport(service, ctx)
    const found = await expectAllowed(() => service.getImport(ctx, created.id))
    expect(found.id).toBe(created.id)
    const listed = await expectAllowed(() => service.listImports(ctx, { limit: 25 }))
    expect(listed.data).toHaveLength(1)
    expect(listed.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("getImport throws NOT_FOUND for unknown ids", async () => {
    const { ctx, service } = setup()
    const err = await service.getImport(ctx, "missing").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe("NOT_FOUND")
  })

  test("dryRunImport previews CSV validation without mutating", async () => {
    const { ctx, service, audits } = setup()
    const created = await seedImport(service, ctx)
    const preview = await expectAllowed(() =>
      service.dryRunImport(ctx, created.id, {
        csvText: "first_name,last_name\nAda,Lovelace\n,Grace\n",
        mapping: { first_name: "firstName", last_name: "lastName" },
      }),
    )
    expect(preview.totalRows).toBe(2)
    expect(preview.validRows).toBe(1)
    expect(preview.invalidRows).toBe(1)
    expect(preview.missingColumns).toEqual([])
    expect(preview.errors.length).toBeGreaterThan(0)
    // Read-only preview: no audit row.
    expect(audits).toHaveLength(1)
  })

  test("completeImport emits import.completed and audits with before/after", async () => {
    const { ctx, service, audits } = setup()
    const created = await seedImport(service, ctx)
    const events = captureEvents()
    try {
      const done = await expectAllowed(() =>
        service.completeImport(ctx, created.id, { succeededRows: 8, failedRows: 2 }),
      )
      expect(done.status).toBe("completed")
      const emitted = events.expectEmitted("import.completed", { entityId: created.id })
      expect(emitted.before).toMatchObject({ status: "pending" })
      expect(emitted.after).toMatchObject({ status: "completed" })
      expect(audits.at(-1)).toMatchObject({ action: "complete", recordId: created.id })
    } finally {
      events.release()
    }
  })

  test("softDeleteImport hides the row; restoreImport revives it", async () => {
    const { ctx, service } = setup()
    const created = await seedImport(service, ctx)
    await expectAllowed(() => service.softDeleteImport(ctx, created.id))
    await expect(service.getImport(ctx, created.id)).rejects.toMatchObject({ code: "NOT_FOUND" })
    const restored = await expectAllowed(() => service.restoreImport(ctx, created.id))
    expect(restored.id).toBe(created.id)
    await expectAllowed(() => service.getImport(ctx, created.id))
  })

  test("createExport emits export.completed, obeys permissions and audits", async () => {
    const { ctx, service, audits } = setup()
    const events = captureEvents()
    try {
      const job = await expectAllowed(() => service.createExport(ctx, { objectType: "person" }))
      expect(job.objectType).toBe("person")
      events.expectEmitted("export.completed", {
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "export_job",
        entityId: job.id,
      })
      expect(audits.at(-1)).toMatchObject({
        action: "create",
        object: "export_job",
        recordId: job.id,
      })
      const listed = await expectAllowed(() => service.listExports(ctx, { limit: 25 }))
      expect(listed.data).toHaveLength(1)
      const found = await expectAllowed(() => service.getExport(ctx, job.id))
      expect(found.id).toBe(job.id)
    } finally {
      events.release()
    }
  })

  test("softDeleteExport hides the row; restoreExport revives it", async () => {
    const { ctx, service } = setup()
    const created = await seedExport(service, ctx)
    await expectAllowed(() => service.softDeleteExport(ctx, created.id))
    await expect(service.getExport(ctx, created.id)).rejects.toMatchObject({ code: "NOT_FOUND" })
    const restored = await expectAllowed(() => service.restoreExport(ctx, created.id))
    expect(restored.id).toBe(created.id)
    await expectAllowed(() => service.getExport(ctx, created.id))
  })

  describe("denials", () => {
    let backing: ReturnType<typeof makeStore>
    let workspaceId: string
    let importId: string
    let exportId: string

    function asRole(role: "owner" | "admin" | "member" | "viewer") {
      return setup(role, backing, workspaceId)
    }

    beforeEach(async () => {
      backing = makeStore()
      const owner = setup("owner", backing)
      workspaceId = owner.ctx.workspaceId
      importId = (await seedImport(owner.service, owner.ctx)).id
      exportId = (await seedExport(owner.service, owner.ctx)).id
    })

    test("viewer cannot create imports", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.createImport(ctx, { objectType: "person" }))
    })

    test("viewer cannot create exports (permission-aware exports)", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.createExport(ctx, { objectType: "person" }))
    })

    test("viewer cannot update imports", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.updateImport(ctx, importId, { fileName: "x.csv" }))
    })

    test("member cannot delete imports (admin-only)", async () => {
      const { ctx, service } = asRole("member")
      await expectDenied(() => service.softDeleteImport(ctx, importId))
    })

    test("member cannot delete exports (admin-only)", async () => {
      const { ctx, service } = asRole("member")
      await expectDenied(() => service.softDeleteExport(ctx, exportId))
    })

    test("viewer can still list and get (read is open)", async () => {
      const { ctx, service } = asRole("viewer")
      await expectAllowed(() => service.listImports(ctx, {}))
      await expectAllowed(() => service.getImport(ctx, importId))
      await expectAllowed(() => service.listExports(ctx, {}))
      await expectAllowed(() => service.getExport(ctx, exportId))
    })
  })
})
