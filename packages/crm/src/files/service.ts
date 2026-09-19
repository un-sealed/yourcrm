import { FileEvents, createEvent, getEventBus } from "@yourcrm/events"
import { requirePermission } from "@yourcrm/permissions"
import { paginationQuerySchema } from "@yourcrm/validation"
import { z } from "zod"
import type {
  DownloadUrlResult,
  FilesServiceContext,
  FilesServiceDeps,
  FileListResult,
  FileRecord,
  UploadUrlResult,
} from "./types"

/**
 * Files zod schemas. The service validates inputs with these; API routes
 * reuse them at the HTTP boundary via `@hono/zod-validator`. (Kept in the
 * service module — unlike people, files has no separate schemas.ts so the
 * module stays inside its reserved file list.)
 */

/** Configured upload size limit: larger uploads are rejected with 413. */
export const MAX_FILE_UPLOAD_BYTES = 25 * 1024 * 1024

const fileNameSchema = z.string().trim().min(1).max(255)

export class FileNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`file ${id} not found`)
    this.name = "FileNotFoundError"
  }
}

export class FileTooLargeError extends Error {
  readonly code = "FILE_TOO_LARGE"
  readonly sizeBytes: number
  readonly maxBytes: number
  constructor(sizeBytes: number, maxBytes: number = MAX_FILE_UPLOAD_BYTES) {
    super(`file size ${sizeBytes} bytes exceeds the ${maxBytes} byte limit`)
    this.name = "FileTooLargeError"
    this.sizeBytes = sizeBytes
    this.maxBytes = maxBytes
  }
}

function assertSizeAllowed(sizeBytes: number): void {
  if (sizeBytes > MAX_FILE_UPLOAD_BYTES) throw new FileTooLargeError(sizeBytes)
}

const subjectSchema = z.object({
  subjectType: z.enum(["person", "company", "deal"]).nullish(),
  subjectId: z.string().min(1).nullish(),
})

export const createFileSchema = z
  .object({
    fileName: fileNameSchema,
    mimeType: z.string().trim().max(128).nullish(),
    sizeBytes: z.number().int().min(0).default(0),
    storageKey: z.string().trim().min(1).max(1024),
    ownerId: z.string().min(1).nullish(),
    description: z.string().max(10000).nullish(),
  })
  .and(subjectSchema)
  .refine(
    (value) => ((value.subjectType ?? null) !== null) === ((value.subjectId ?? null) !== null),
    {
      message: "subjectType and subjectId must be provided together",
    },
  )

export type CreateFileInput = z.infer<typeof createFileSchema>

export const updateFileSchema = z
  .object({
    fileName: fileNameSchema.optional(),
    mimeType: z.string().trim().max(128).nullish(),
    ownerId: z.string().min(1).nullish(),
    description: z.string().max(10000).nullish(),
  })
  .and(subjectSchema.partial())
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })
  .refine((value) => (value.subjectType === undefined) === (value.subjectId === undefined), {
    message: "subjectType and subjectId must be provided together",
  })

export type UpdateFileInput = z.infer<typeof updateFileSchema>

export const uploadUrlRequestSchema = z
  .object({
    fileName: fileNameSchema,
    mimeType: z.string().trim().max(128).nullish(),
    sizeBytes: z.number().int().min(1),
  })
  .and(subjectSchema)
  .refine(
    (value) => ((value.subjectType ?? null) !== null) === ((value.subjectId ?? null) !== null),
    {
      message: "subjectType and subjectId must be provided together",
    },
  )

export type UploadUrlRequest = z.infer<typeof uploadUrlRequestSchema>

export const fileQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
  mimeType: z.string().trim().max(128).optional(),
  subjectType: z.enum(["person", "company", "deal"]).optional(),
})

export type FileQuery = z.infer<typeof fileQuerySchema>

export const fileSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  fileName: z.string(),
  mimeType: z.string().nullable().optional(),
  sizeBytes: z.number(),
  storageKey: z.string(),
  subjectType: z.string().nullable().optional(),
  subjectId: z.string().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type FileDto = z.infer<typeof fileSchema>

function permissionOf(ctx: FilesServiceContext, action: "read" | "create" | "update" | "delete") {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "file",
    action,
  }
}

/**
 * Files domain service (mirrors the people service).
 *
 * Every method:
 *  1. calls `requirePermission()` FIRST, before any read or write;
 *  2. does the work through the injected `FilesStore` port;
 *  3. emits the domain event via the `FileEvents` constant (never a literal);
 *  4. writes the audit row with before/after (mutations only).
 *
 * Update and restore write audit rows but emit no domain event: the reserved
 * file event constants only cover `file.uploaded` and `file.deleted`.
 */
export function createFilesService(deps: FilesServiceDeps) {
  const events = deps.events ?? getEventBus()

  function urls() {
    if (!deps.urls) throw new Error("files.urls: no URL signer configured")
    return deps.urls
  }

  async function list(ctx: FilesServiceContext, rawQuery: unknown): Promise<FileListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = fileQuerySchema.parse(rawQuery)
    return deps.store.list(ctx.workspaceId, query)
  }

  async function get(ctx: FilesServiceContext, id: string): Promise<FileRecord> {
    requirePermission(permissionOf(ctx, "read"))
    const found = await deps.store.findById(ctx.workspaceId, id)
    if (!found) throw new FileNotFoundError(id)
    return found
  }

  async function create(ctx: FilesServiceContext, rawInput: unknown): Promise<FileRecord> {
    requirePermission(permissionOf(ctx, "create"))
    const input = createFileSchema.parse(rawInput)
    assertSizeAllowed(input.sizeBytes)
    const file = await deps.store.create(
      ctx.workspaceId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    await events.emit(
      createEvent({
        event: FileEvents.FileUploaded,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "file",
        entityId: file.id,
        after: file,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "file",
      recordId: file.id,
      after: file,
      correlationId: ctx.correlationId,
    })
    return file
  }

  async function update(
    ctx: FilesServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<FileRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const patch = updateFileSchema.parse(rawPatch)
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new FileNotFoundError(id)
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new FileNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "file",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function softDelete(ctx: FilesServiceContext, id: string): Promise<FileRecord> {
    requirePermission(permissionOf(ctx, "delete"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new FileNotFoundError(id)
    await deps.store.softDelete(ctx.workspaceId, id, ctx.actorId)
    await events.emit(
      createEvent({
        event: FileEvents.FileDeleted,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "file",
        entityId: id,
        before,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "file",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function restore(ctx: FilesServiceContext, id: string): Promise<FileRecord> {
    requirePermission(permissionOf(ctx, "update"))
    await deps.store.restore(ctx.workspaceId, id)
    const after = await deps.store.findById(ctx.workspaceId, id)
    if (!after) throw new FileNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "restore",
      object: "file",
      recordId: id,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function getUploadUrl(
    ctx: FilesServiceContext,
    rawInput: unknown,
  ): Promise<UploadUrlResult> {
    requirePermission(permissionOf(ctx, "create"))
    const input = uploadUrlRequestSchema.parse(rawInput)
    assertSizeAllowed(input.sizeBytes)
    const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 100)
    const storageKey = `${ctx.workspaceId}/${crypto.randomUUID()}/${safeName}`
    const uploadUrl = await urls().signUpload(storageKey, input.mimeType ?? null)
    return {
      uploadUrl,
      storageKey,
      fileName: input.fileName,
      mimeType: input.mimeType ?? null,
      sizeBytes: input.sizeBytes,
    }
  }

  async function getDownloadUrl(ctx: FilesServiceContext, id: string): Promise<DownloadUrlResult> {
    requirePermission(permissionOf(ctx, "read"))
    const found = await deps.store.findById(ctx.workspaceId, id)
    if (!found) throw new FileNotFoundError(id)
    const downloadUrl = await urls().signDownload(found.storageKey as string)
    return {
      downloadUrl,
      fileName: found.fileName,
      mimeType: found.mimeType,
      sizeBytes: found.sizeBytes,
    }
  }

  return { list, get, create, update, softDelete, restore, getUploadUrl, getDownloadUrl }
}

export type FilesService = ReturnType<typeof createFilesService>
