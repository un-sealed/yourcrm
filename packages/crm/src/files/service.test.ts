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
  createFilesService,
  FileTooLargeError,
  MAX_FILE_UPLOAD_BYTES,
  type FilesService,
  type FileRecord,
} from "./index"
import type { FileAuditInput, FileListQuery, UrlSigner } from "./types"

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

function fakeUrls(): UrlSigner & { calls: { upload: string[]; download: string[] } } {
  const calls = { upload: [] as string[], download: [] as string[] }
  return {
    calls,
    signUpload: async (key: string) => {
      calls.upload.push(key)
      return `https://storage.example/upload/${key}`
    },
    signDownload: async (key: string) => {
      calls.download.push(key)
      return `https://storage.example/download/${key}`
    },
  }
}

/** Hermetic FilesStore port backed by the shared in-memory store. */
function makeStore() {
  const files = createStore<StoredFile>()
  return {
    files,
    store: {
      list: async (workspaceId: string, query: FileListQuery) => {
        let rows = files.list(workspaceId)
        if (query.mimeType) rows = rows.filter((r) => r.mimeType === query.mimeType)
        if (query.subjectType) rows = rows.filter((r) => r.subjectType === query.subjectType)
        if (query.query) {
          const q = query.query.toLowerCase()
          rows = rows.filter((r) => r.fileName.toLowerCase().includes(q))
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
        const row = files.get(id, workspaceId)
        return row ? asRecord(row) : null
      },
      create: async (workspaceId: string, input: Record<string, unknown>, actorId?: string) => {
        const record: StoredFile = {
          ...makeBaseRecord({ workspaceId }),
          fileName: input.fileName as string,
          mimeType: (input.mimeType as string | null) ?? null,
          sizeBytes: (input.sizeBytes as number) ?? 0,
          storageKey: input.storageKey as string,
          subjectType: (input.subjectType as string | null) ?? null,
          subjectId: (input.subjectId as string | null) ?? null,
          ownerId: (input.ownerId as string | null) ?? null,
          description: (input.description as string | null) ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }
        return asRecord(files.insert(record))
      },
      update: async (
        workspaceId: string,
        id: string,
        input: Record<string, unknown>,
        _actorId?: string,
      ) => {
        const row = files.update(id, workspaceId, input as Partial<StoredFile>)
        return row ? asRecord(row) : null
      },
      softDelete: async (workspaceId: string, id: string) => {
        files.remove(id, workspaceId)
      },
      restore: async (workspaceId: string, id: string) => {
        files.restore(id, workspaceId)
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
  const audits: FileAuditInput[] = []
  const backing = shared ?? makeStore()
  const urls = fakeUrls()
  const service = createFilesService({
    store: backing.store,
    audit: async (input) => void audits.push(input),
    urls,
  })
  return { ctx, service, audits, session, backing, urls }
}

async function seed(service: FilesService, ctx: ServiceContext, fileName = "contract.pdf") {
  return service.create(ctx, { fileName, storageKey: `ws/${fileName}`, sizeBytes: 1024 })
}

describe("files/service", () => {
  test("create validates, emits file.uploaded and audits with after", async () => {
    const { ctx, service, audits } = setup()
    const events = captureEvents()
    try {
      const file = await expectAllowed(() =>
        service.create(ctx, { fileName: "contract.pdf", storageKey: "ws/contract.pdf" }),
      )
      expect(file.fileName).toBe("contract.pdf")
      events.expectEmitted("file.uploaded", {
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "file",
        entityId: file.id,
      })
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({
        workspaceId: ctx.workspaceId,
        action: "create",
        object: "file",
        recordId: file.id,
      })
      expect(audits[0]?.after).toMatchObject({ fileName: "contract.pdf" })
    } finally {
      events.release()
    }
  })

  test("create rejects invalid input before touching the store", async () => {
    const { ctx, service } = setup()
    await expect(service.create(ctx, { fileName: "  " })).rejects.toThrow()
  })

  test("create rejects a lone subjectType without subjectId", async () => {
    const { ctx, service } = setup()
    await expect(
      service.create(ctx, { fileName: "a.pdf", storageKey: "k", subjectType: "person" }),
    ).rejects.toThrow()
  })

  test("create rejects uploads above the configured size limit", async () => {
    const { ctx, service } = setup()
    const err = await service
      .create(ctx, {
        fileName: "huge.bin",
        storageKey: "ws/huge.bin",
        sizeBytes: MAX_FILE_UPLOAD_BYTES + 1,
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FileTooLargeError)
    expect((err as { code?: string }).code).toBe("FILE_TOO_LARGE")
  })

  test("get returns the file, list paginates and filters", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const found = await expectAllowed(() => service.get(ctx, created.id))
    expect(found.id).toBe(created.id)
    const listed = await expectAllowed(() => service.list(ctx, { limit: 25 }))
    expect(listed.data).toHaveLength(1)
    expect(listed.pagination).toEqual({ nextCursor: null, limit: 25 })
    const filtered = await expectAllowed(() => service.list(ctx, { query: "contract" }))
    expect(filtered.data).toHaveLength(1)
    const missed = await expectAllowed(() => service.list(ctx, { query: "invoice" }))
    expect(missed.data).toHaveLength(0)
  })

  test("get throws NOT_FOUND for unknown ids", async () => {
    const { ctx, service } = setup()
    const err = await service.get(ctx, "missing").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe("NOT_FOUND")
  })

  test("update audits with before/after", async () => {
    const { ctx, service, audits } = setup()
    const created = await seed(service, ctx)
    const updated = await expectAllowed(() =>
      service.update(ctx, created.id, { description: "Signed copy" }),
    )
    expect(updated.description).toBe("Signed copy")
    expect(audits.at(-1)).toMatchObject({ action: "update", recordId: created.id })
    expect(audits.at(-1)?.before).toMatchObject({ description: null })
    expect(audits.at(-1)?.after).toMatchObject({ description: "Signed copy" })
  })

  test("softDelete emits file.deleted and hides the row; restore revives it", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      await expectAllowed(() => service.softDelete(ctx, created.id))
      events.expectEmitted("file.deleted", { entityId: created.id })
      await expect(service.get(ctx, created.id)).rejects.toMatchObject({ code: "NOT_FOUND" })
      const restored = await expectAllowed(() => service.restore(ctx, created.id))
      expect(restored.id).toBe(created.id)
      await expectAllowed(() => service.get(ctx, created.id))
    } finally {
      events.release()
    }
  })

  test("getUploadUrl mints a presigned URL without touching bytes", async () => {
    const { ctx, service, urls } = setup()
    const result = await expectAllowed(() =>
      service.getUploadUrl(ctx, {
        fileName: "deck.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
      }),
    )
    expect(result.uploadUrl).toContain("/upload/")
    expect(result.storageKey).toContain(ctx.workspaceId)
    expect(urls.calls.upload).toHaveLength(1)
  })

  test("getUploadUrl rejects oversize uploads before signing", async () => {
    const { ctx, service, urls } = setup()
    await expect(
      service.getUploadUrl(ctx, { fileName: "huge.bin", sizeBytes: MAX_FILE_UPLOAD_BYTES + 1 }),
    ).rejects.toBeInstanceOf(FileTooLargeError)
    expect(urls.calls.upload).toHaveLength(0)
  })

  test("getDownloadUrl returns a signed URL for the stored key", async () => {
    const { ctx, service, urls } = setup()
    const created = await seed(service, ctx)
    const result = await expectAllowed(() => service.getDownloadUrl(ctx, created.id))
    expect(result.downloadUrl).toContain("ws/contract.pdf")
    expect(urls.calls.download).toEqual(["ws/contract.pdf"])
  })

  describe("denials", () => {
    let backing: ReturnType<typeof makeStore>
    let workspaceId: string
    let fileId: string

    function asRole(role: "owner" | "admin" | "member" | "viewer") {
      return setup(role, backing, workspaceId)
    }

    beforeEach(async () => {
      backing = makeStore()
      const owner = setup("owner", backing)
      workspaceId = owner.ctx.workspaceId
      fileId = (await seed(owner.service, owner.ctx)).id
    })

    test("viewer cannot create", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.create(ctx, { fileName: "Nope", storageKey: "k" }))
    })

    test("viewer cannot update", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.update(ctx, fileId, { description: "X" }))
    })

    test("viewer cannot mint upload URLs but can still download (read is open)", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.getUploadUrl(ctx, { fileName: "x.pdf", sizeBytes: 10 }))
      await expectAllowed(() => service.getDownloadUrl(ctx, fileId))
    })

    test("member cannot delete (admin-only)", async () => {
      const { ctx, service } = asRole("member")
      await expectDenied(() => service.softDelete(ctx, fileId))
    })

    test("viewer can still list and get (read is open)", async () => {
      const { ctx, service } = asRole("viewer")
      await expectAllowed(() => service.list(ctx, {}))
      await expectAllowed(() => service.get(ctx, fileId))
    })
  })
})
