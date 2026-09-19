import type { FilterFieldDef, FilterTree } from "@yourcrm/ui"

/** File record as returned by `GET /api/v1/files` (envelope `data` item). */
export type FileItem = {
  id: string
  workspaceId: string
  fileName: string
  mimeType: string | null
  sizeBytes: number
  storageKey: string
  subjectType: string | null
  subjectId: string | null
  ownerId: string | null
  description: string | null
  createdAt: string
  updatedAt: string
}

export type FilesListResponse = {
  data: FileItem[]
  pagination: { nextCursor: string | null; limit: number }
}

export type UploadUrlResponse = {
  uploadUrl: string
  storageKey: string
  fileName: string
  mimeType: string | null
  sizeBytes: number
}

export function formatBytes(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const index = Math.min(Math.floor(Math.log(sizeBytes) / Math.log(1024)), units.length - 1)
  const value = sizeBytes / 1024 ** index
  return `${value >= 100 ? Math.round(value).toString() : value.toFixed(1)} ${units[index]}`
}

export function subjectLabel(file: Pick<FileItem, "subjectType" | "subjectId">): string | null {
  if (!file.subjectType || !file.subjectId) return null
  return `${file.subjectType} ${file.subjectId.slice(0, 8)}`
}

/** Deep link to the attached record for known subject types. */
export function subjectHref(file: Pick<FileItem, "subjectType" | "subjectId">): string | null {
  if (!file.subjectType || !file.subjectId) return null
  if (file.subjectType === "person") return `/app/people/${file.subjectId}`
  if (file.subjectType === "company") return `/app/companies/${file.subjectId}`
  if (file.subjectType === "deal") return `/app/deals/${file.subjectId}`
  return null
}

export const FILE_FILTER_FIELDS: FilterFieldDef[] = [
  { name: "fileName", label: "File name", type: "text" },
  { name: "mimeType", label: "Type", type: "text" },
  {
    name: "subjectType",
    label: "Attached to",
    type: "select",
    options: [
      { value: "person", label: "Person" },
      { value: "company", label: "Company" },
      { value: "deal", label: "Deal" },
    ],
  },
]

export type { FilterTree }
