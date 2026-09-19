import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import { createFilesService, type FilesService } from "@yourcrm/crm/src/files"
import type { FilesStore, FileRecord } from "@yourcrm/crm/src/files"
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
import { createRoutes } from "./files"

type StoredFile = BaseRecord & {
  fileName: string
  mimeType: string | null
  sizeBytes: number
  storageKey: string
  subjectType: string | null
  subjectId: string | null
  ownerId: string | null
  description: string | null
}

function asRecord(row: StoredFile): FileRecord {
  return row as unknown as FileRecord
}

/** Real domain service over a hermetic in-memory store. */
function makeFakeService() {
  const files = createStore<StoredFile>()
  const store: FilesStore = {
    list: async (workspaceId, query) => {
      const rows = files.list(workspaceId)
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
      const row = files.get(id, workspaceId)
      return row ? asRecord(row) : null
    },
    create: async (workspaceId, input, actorId) => {
      return asRecord(
        files.insert({
          ...makeBaseRecord({ workspaceId }),
          fileName: input.fileName as string,
          mimeType: (input.mimeType as string | null) ?? null,
          sizeBytes: (input.sizeBytes as number) ?? 0,
          storageKey: input.storageKey as string,
          subjectType: null,
          subjectId: null,
          ownerId: null,
          description: null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      )
    },
    update: async (workspaceId, id, input) => {
      const row = files.update(id, workspaceId, input as Partial<StoredFile>)
      return row ? asRecord(row) : null
    },
    softDelete: async (workspaceId, id) => {
      files.remove(id, workspaceId)
    },
    restore: async (workspaceId, id) => {
      files.restore(id, workspaceId)
    },
  }
  return createFilesService({
    store,
    audit: async () => undefined,
    urls: {
      signUpload: async (key: string) => `https://storage.example/upload/${key}`,
      signDownload: async (key: string) => `https://storage.example/download/${key}`,
    },
  })
}

/**
 * Hermetic API test: the route factory takes a service, so tests inject the
 * real domain service over an in-memory store. Sessions ride a tiny test-only
 * middleware (role-accurate without touching the foundation auth hook).
 */
function makeTestApp(session: { current: Session | null }, service: FilesService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/files", createRoutes({ service }))
  return app
}

describe("api/files", () => {
  let session: { current: Session | null }
  let service: FilesService
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
    const res = await api.get("/api/v1/files")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("list returns the cursor pagination envelope", async () => {
    await service.create(ctx, { fileName: "contract.pdf", storageKey: "ws/contract.pdf" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/files")
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("get returns the file; unknown id is NOT_FOUND", async () => {
    const created = await service.create(ctx, {
      fileName: "contract.pdf",
      storageKey: "ws/contract.pdf",
    })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const ok = await api.get(`/api/v1/files/${created.id}`)
    expect(ok.status).toBe(200)
    const data = ok.expectSuccess().data as { id: string }
    expect(data.id).toBe(created.id)
    const missing = await api.get("/api/v1/files/does-not-exist")
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")
  })

  test("create validates the body and returns 201", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const bad = await api.post("/api/v1/files", { fileName: "  " })
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")
    const good = await api.post("/api/v1/files", {
      fileName: "contract.pdf",
      storageKey: "ws/contract.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
    })
    expect(good.status).toBe(201)
    expect((good.expectSuccess().data as { fileName: string }).fileName).toBe("contract.pdf")
  })

  test("oversize metadata is rejected with FILE_TOO_LARGE (413)", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/files", {
      fileName: "huge.bin",
      storageKey: "ws/huge.bin",
      sizeBytes: 25 * 1024 * 1024 + 1,
    })
    expect(res.status).toBe(413)
    res.expectError("FILE_TOO_LARGE")
  })

  test("upload-url mints a presigned URL; oversize is rejected with 413", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const good = await api.post("/api/v1/files/upload-url", {
      fileName: "deck.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
    })
    expect(good.status).toBe(201)
    const data = good.expectSuccess().data as { uploadUrl: string; storageKey: string }
    expect(data.uploadUrl).toContain("/upload/")
    expect(data.storageKey).toContain(ctx.workspaceId)
    const big = await api.post("/api/v1/files/upload-url", {
      fileName: "huge.bin",
      sizeBytes: 25 * 1024 * 1024 + 1,
    })
    expect(big.status).toBe(413)
    big.expectError("FILE_TOO_LARGE")
  })

  test("download-url returns a signed URL; unknown id is NOT_FOUND", async () => {
    const created = await service.create(ctx, {
      fileName: "contract.pdf",
      storageKey: "ws/contract.pdf",
    })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const ok = await api.get(`/api/v1/files/${created.id}/download-url`)
    expect(ok.status).toBe(200)
    const data = ok.expectSuccess().data as { downloadUrl: string }
    expect(data.downloadUrl).toContain("ws/contract.pdf")
    const missing = await api.get("/api/v1/files/does-not-exist/download-url")
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")
  })

  test("viewer create is FORBIDDEN (service denial maps to 403)", async () => {
    session.current = makeSession({ role: "viewer", workspaceId: ctx.workspaceId })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/files", { fileName: "Nope", storageKey: "k" })
    expect(res.status).toBe(403)
    const err = res.expectError("FORBIDDEN")
    expect(err.error.message).toContain("create")
  })

  test("update, delete and restore round-trip", async () => {
    const created = await service.create(ctx, {
      fileName: "contract.pdf",
      storageKey: "ws/contract.pdf",
    })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const patched = await api.patch(`/api/v1/files/${created.id}`, {
      description: "Signed copy",
    })
    expect(patched.status).toBe(200)
    const deleted = await api.delete(`/api/v1/files/${created.id}`)
    expect(deleted.status).toBe(200)
    const gone = await api.get(`/api/v1/files/${created.id}`)
    expect(gone.status).toBe(404)
    const restored = await api.post(`/api/v1/files/${created.id}/restore`)
    expect(restored.status).toBe(200)
    const back = await api.get(`/api/v1/files/${created.id}`)
    expect(back.status).toBe(200)
  })
})
