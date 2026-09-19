import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import { createImportExportService, type ImportExportService } from "@yourcrm/crm/src/import-export"
import type {
  ExportJobRecord,
  ImportExportStore,
  ImportJobRecord,
} from "@yourcrm/crm/src/import-export"
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
import { createRoutes } from "./import-export"

type StoredImport = BaseRecord & { objectType: string; status: string }
type StoredExport = BaseRecord & { objectType: string; status: string }

function asImport(row: StoredImport): ImportJobRecord {
  return row as unknown as ImportJobRecord
}

function asExport(row: StoredExport): ExportJobRecord {
  return row as unknown as ExportJobRecord
}

/** Real domain service over hermetic in-memory stores. */
function makeFakeService() {
  const imports = createStore<StoredImport>()
  const exports = createStore<StoredExport>()
  const store: ImportExportStore = {
    listImports: async (workspaceId, query) => {
      const rows = imports.list(workspaceId)
      const limit = query.limit ?? 25
      const data = rows.slice(0, limit)
      return {
        data: data.map(asImport),
        pagination: {
          nextCursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null,
          limit,
        },
      }
    },
    findImportById: async (workspaceId, id) => {
      const row = imports.get(id, workspaceId)
      return row ? asImport(row) : null
    },
    createImport: async (workspaceId, input, actorId) => {
      return asImport(
        imports.insert({
          ...makeBaseRecord({ workspaceId }),
          objectType: input.objectType as string,
          status: "pending",
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      )
    },
    updateImport: async (workspaceId, id, input) => {
      const row = imports.update(id, workspaceId, input as Partial<StoredImport>)
      return row ? asImport(row) : null
    },
    softDeleteImport: async (workspaceId, id) => {
      imports.remove(id, workspaceId)
    },
    restoreImport: async (workspaceId, id) => {
      imports.restore(id, workspaceId)
    },
    listExports: async (workspaceId, query) => {
      const rows = exports.list(workspaceId)
      const limit = query.limit ?? 25
      const data = rows.slice(0, limit)
      return {
        data: data.map(asExport),
        pagination: {
          nextCursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null,
          limit,
        },
      }
    },
    findExportById: async (workspaceId, id) => {
      const row = exports.get(id, workspaceId)
      return row ? asExport(row) : null
    },
    createExport: async (workspaceId, input, actorId) => {
      return asExport(
        exports.insert({
          ...makeBaseRecord({ workspaceId }),
          objectType: input.objectType as string,
          status: "pending",
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      )
    },
    updateExport: async (workspaceId, id, input) => {
      const row = exports.update(id, workspaceId, input as Partial<StoredExport>)
      return row ? asExport(row) : null
    },
    softDeleteExport: async (workspaceId, id) => {
      exports.remove(id, workspaceId)
    },
    restoreExport: async (workspaceId, id) => {
      exports.restore(id, workspaceId)
    },
  }
  return createImportExportService({ store, audit: async () => undefined })
}

/**
 * Hermetic API test: the route factory takes a service, so tests inject the
 * real domain service over in-memory stores. Sessions ride a tiny test-only
 * middleware (role-accurate without touching the foundation auth hook).
 */
function makeTestApp(session: { current: Session | null }, service: ImportExportService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/import-export", createRoutes({ service }))
  return app
}

describe("api/import-export", () => {
  let session: { current: Session | null }
  let service: ImportExportService
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
    const res = await api.get("/api/v1/import-export/imports")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("import list returns the cursor pagination envelope", async () => {
    await service.createImport(ctx, { objectType: "person" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/import-export/imports")
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("import get returns the job; unknown id is NOT_FOUND", async () => {
    const created = await service.createImport(ctx, { objectType: "person" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const ok = await api.get(`/api/v1/import-export/imports/${created.id}`)
    expect(ok.status).toBe(200)
    expect((ok.expectSuccess().data as { id: string }).id).toBe(created.id)
    const missing = await api.get("/api/v1/import-export/imports/does-not-exist")
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")
  })

  test("import create validates the body and returns 201", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const bad = await api.post("/api/v1/import-export/imports", { objectType: "  " })
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")
    const good = await api.post("/api/v1/import-export/imports", {
      objectType: "person",
      mode: "upsert",
    })
    expect(good.status).toBe(201)
    expect((good.expectSuccess().data as { objectType: string }).objectType).toBe("person")
  })

  test("viewer import create is FORBIDDEN (service denial maps to 403)", async () => {
    session.current = makeSession({ role: "viewer", workspaceId: ctx.workspaceId })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/import-export/imports", { objectType: "person" })
    expect(res.status).toBe(403)
    const err = res.expectError("FORBIDDEN")
    expect(err.error.message).toContain("create")
  })

  test("viewer export create is FORBIDDEN (permission-aware exports)", async () => {
    session.current = makeSession({ role: "viewer", workspaceId: ctx.workspaceId })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/import-export/exports", { objectType: "person" })
    expect(res.status).toBe(403)
    res.expectError("FORBIDDEN")
  })

  test("dry-run previews validation; complete closes the job", async () => {
    const created = await service.createImport(ctx, { objectType: "person" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const preview = await api.post(`/api/v1/import-export/imports/${created.id}/dry-run`, {
      csvText: "first_name,last_name\nAda,Lovelace\n",
    })
    expect(preview.status).toBe(200)
    const data = preview.expectSuccess().data as { totalRows: number; validRows: number }
    expect(data.totalRows).toBe(1)
    expect(data.validRows).toBe(1)
    const done = await api.post(`/api/v1/import-export/imports/${created.id}/complete`, {
      succeededRows: 1,
      failedRows: 0,
    })
    expect(done.status).toBe(200)
    expect((done.expectSuccess().data as { status: string }).status).toBe("completed")
  })

  test("export create validates and returns 201; list envelopes paginate", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const bad = await api.post("/api/v1/import-export/exports", { objectType: "" })
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")
    const good = await api.post("/api/v1/import-export/exports", { objectType: "deal" })
    expect(good.status).toBe(201)
    const listed = await api.get("/api/v1/import-export/exports")
    expect(listed.status).toBe(200)
    expect(listed.expectSuccess().data).toHaveLength(1)
  })

  test("import update, delete and restore round-trip", async () => {
    const created = await service.createImport(ctx, { objectType: "person" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const patched = await api.patch(`/api/v1/import-export/imports/${created.id}`, {
      fileName: "people.csv",
    })
    expect(patched.status).toBe(200)
    const deleted = await api.delete(`/api/v1/import-export/imports/${created.id}`)
    expect(deleted.status).toBe(200)
    const gone = await api.get(`/api/v1/import-export/imports/${created.id}`)
    expect(gone.status).toBe(404)
    const restored = await api.post(`/api/v1/import-export/imports/${created.id}/restore`)
    expect(restored.status).toBe(200)
    const back = await api.get(`/api/v1/import-export/imports/${created.id}`)
    expect(back.status).toBe(200)
  })

  test("export update, delete and restore round-trip", async () => {
    const created = await service.createExport(ctx, { objectType: "person" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const patched = await api.patch(`/api/v1/import-export/exports/${created.id}`, {
      fileName: "people-export.csv",
    })
    expect(patched.status).toBe(200)
    const deleted = await api.delete(`/api/v1/import-export/exports/${created.id}`)
    expect(deleted.status).toBe(200)
    const gone = await api.get(`/api/v1/import-export/exports/${created.id}`)
    expect(gone.status).toBe(404)
    const restored = await api.post(`/api/v1/import-export/exports/${created.id}/restore`)
    expect(restored.status).toBe(200)
  })
})
