export {
  createFilesService,
  createFileSchema,
  FileNotFoundError,
  fileQuerySchema,
  FileTooLargeError,
  fileSchema,
  MAX_FILE_UPLOAD_BYTES,
  updateFileSchema,
  uploadUrlRequestSchema,
} from "./service"
export type {
  CreateFileInput,
  FileDto,
  FileQuery,
  FilesService,
  UpdateFileInput,
  UploadUrlRequest,
} from "./service"
export type {
  DownloadUrlResult,
  FileAuditInput,
  FileListQuery,
  FileListResult,
  FileRecord,
  FilesServiceContext,
  FilesServiceDeps,
  FilesStore,
  UploadUrlResult,
  UrlSigner,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
