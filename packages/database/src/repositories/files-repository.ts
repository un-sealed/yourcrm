import { and, eq, ilike, isNull, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import { files, isFileSubjectType, type NewFile, type File as FileRow } from "../schema/files"
import { createBaseRepository } from "./base-repository"

export type CreateFileInput = {
  fileName: string
  mimeType?: string | null
  sizeBytes?: number | null
  storageKey: string
  subjectType?: string | null
  subjectId?: string | null
  ownerId?: string | null
  description?: string | null
}

export type UpdateFileInput = Partial<
  Pick<NewFile, "fileName" | "mimeType" | "subjectType" | "subjectId" | "ownerId" | "description">
>

/** Trimmed, non-empty file name (max 255, mirrors the column). */
export function normalizeFileName(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new Error("files.create: fileName must not be empty")
  if (trimmed.length > 255) throw new Error("files.create: fileName must be at most 255 characters")
  return trimmed
}

export function normalizeStorageKey(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error("files.create: storageKey must not be empty")
  if (trimmed.length > 1024)
    throw new Error("files.create: storageKey must be at most 1024 characters")
  return trimmed
}

function toFileValues(
  workspaceId: string,
  input: CreateFileInput | UpdateFileInput,
  actorId?: string,
): Partial<NewFile> {
  const values: Partial<NewFile> = {}
  if (input.fileName !== undefined) values.fileName = normalizeFileName(input.fileName)
  if (input.mimeType !== undefined) {
    const mime = input.mimeType?.trim() || null
    if (mime !== null && mime.length > 128) {
      throw new Error("files.create: mimeType must be at most 128 characters")
    }
    values.mimeType = mime
  }
  if (input.subjectType !== undefined) {
    if (input.subjectType !== null && !isFileSubjectType(input.subjectType)) {
      throw new Error("files.create: subjectType must be one of person, company, deal")
    }
    values.subjectType = input.subjectType
  }
  if (input.subjectId !== undefined) values.subjectId = input.subjectId
  if (input.ownerId !== undefined) values.ownerId = input.ownerId
  if (input.description !== undefined) values.description = input.description
  if (actorId !== undefined) {
    values.updatedBy = actorId
  }
  return { ...values, workspaceId }
}

/**
 * Workspace-scoped file metadata. `subjectId` stays a plain column (no join
 * here) until the cross-module foreign-key pass; bytes live in S3/MinIO and
 * are addressed through `storageKey`.
 */
export function createFilesRepository() {
  const base = createBaseRepository(files)

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateFileInput,
      actorId?: string,
    ): Promise<FileRow> {
      const rows = await db
        .insert(files)
        .values({
          ...toFileValues(workspaceId, input, actorId),
          workspaceId,
          fileName: normalizeFileName(input.fileName),
          storageKey: normalizeStorageKey(input.storageKey),
          sizeBytes: input.sizeBytes ?? 0,
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("files.create: insert returned no rows")
      return row
    },

    /** Cursor-paginated list with optional name/mime-type/subject search. */
    async search(
      db: Database,
      opts: { workspaceId: string; limit?: number; cursor?: string; order?: "asc" | "desc" } & {
        query?: string
        mimeType?: string
        subjectType?: string
      },
    ) {
      const conditions: SQL[] = []
      if (opts.query) {
        const q = `%${opts.query.trim()}%`
        const nameMatch = ilike(files.fileName, q)
        if (nameMatch) conditions.push(nameMatch)
      }
      if (opts.mimeType) conditions.push(eq(files.mimeType, opts.mimeType))
      if (opts.subjectType) {
        if (!isFileSubjectType(opts.subjectType)) {
          throw new Error("files.search: unknown subjectType filter")
        }
        conditions.push(eq(files.subjectType, opts.subjectType))
      }
      const result = await base.list(db, { ...opts, where: conditions })
      return { data: result.data as FileRow[], pagination: result.pagination }
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateFileInput,
      actorId?: string,
    ): Promise<FileRow | null> {
      const rows = await db
        .update(files)
        .set({ ...toFileValues(workspaceId, input, actorId), updatedAt: new Date() })
        .where(and(eq(files.id, id), eq(files.workspaceId, workspaceId), isNull(files.deletedAt)))
        .returning()
      return rows[0] ?? null
    },

    async findById(db: Database, workspaceId: string, id: string): Promise<FileRow | null> {
      // The shared base narrows rows to the BaseRecord columns; re-select the
      // concrete table here so callers get the full File shape.
      const row = await base.findById(db, workspaceId, id)
      return (row as FileRow | null) ?? null
    },
  }
}

export type FilesRepository = ReturnType<typeof createFilesRepository>
