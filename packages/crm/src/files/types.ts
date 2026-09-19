import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"

/**
 * Files service ports (mirrors the people module pattern).
 *
 * `@yourcrm/crm` has no database dependency, so the service never imports
 * `@yourcrm/database`. It depends on these structural ports instead; the API
 * layer adapts the drizzle repository (`files-repository.ts`) and
 * `writeAudit` to them. Any object with matching methods satisfies the
 * port — including the `createStore` fake in hermetic tests.
 *
 * Bytes never flow through the service: S3/MinIO presigned URLs are minted
 * through the `UrlSigner` port, which the API layer binds to the real
 * `@yourcrm/storage` client.
 */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type FileRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
}

export type FileListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
  mimeType?: string
  subjectType?: string
}

export type FileListResult = {
  data: FileRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type FilesStore = {
  list(workspaceId: string, query: FileListQuery): Promise<FileListResult>
  findById(workspaceId: string, id: string): Promise<FileRecord | null>
  create(workspaceId: string, input: Record<string, unknown>, actorId?: string): Promise<FileRecord>
  update(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<FileRecord | null>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  restore(workspaceId: string, id: string): Promise<void>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type FileAuditInput = {
  workspaceId: string
  actorId?: string | null
  action: string
  object: string
  recordId?: string | null
  before?: unknown
  after?: unknown
  correlationId?: string | null
  source?: "user" | "automation" | "ai" | "integration" | "mcp"
}

/**
 * Presigned-URL port. The API layer binds this to `@yourcrm/storage` (PUT
 * for uploads, GET for downloads); tests inject a fake. The service never
 * sees bytes — only keys and URLs.
 */
export type UrlSigner = {
  signUpload(key: string, mimeType?: string | null): Promise<string>
  signDownload(key: string): Promise<string>
}

export type UploadUrlResult = {
  uploadUrl: string
  storageKey: string
  fileName: string
  mimeType: string | null
  sizeBytes: number
}

export type DownloadUrlResult = {
  downloadUrl: string
  fileName: unknown
  mimeType: unknown
  sizeBytes: unknown
}

export type FilesServiceContext = ServiceContext

export type FilesServiceDeps = {
  store: FilesStore
  audit: AuditWriter<FileAuditInput>
  events?: EventEmitter
  urls?: UrlSigner
}
