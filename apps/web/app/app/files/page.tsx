"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import {
  Badge,
  BulkBar,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FilterBuilder,
  SavedViews,
  Skeleton,
  TextField,
  decodeFilterTree,
  emptyFilterTree,
  encodeFilterTree,
  toast,
  type DataTableColumn,
  type FilterTree,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import { treeToFilesParams } from "./_components/filters"
import {
  FILE_FILTER_FIELDS,
  formatBytes,
  subjectHref,
  subjectLabel,
  type FileItem,
  type FilesListResponse,
  type UploadUrlResponse,
} from "./_components/types"

type SavedViewState = { id: string; name: string; tree: FilterTree; search: string }

const VIEWS_KEY = "yourcrm.files.views"

function readViews(): SavedViewState[] {
  try {
    const raw = window.localStorage.getItem(VIEWS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (v): v is SavedViewState =>
        typeof v === "object" && v !== null && typeof (v as { id: string }).id === "string",
    )
  } catch {
    return []
  }
}

function fileColumns(): DataTableColumn<FileItem>[] {
  return [
    {
      id: "fileName",
      header: "Name",
      sortable: true,
      accessor: (row) => (
        <Link href={`/app/files/${row.id}`} className="font-medium text-primary hover:underline">
          {row.fileName}
        </Link>
      ),
    },
    {
      id: "mimeType",
      header: "Type",
      sortable: true,
      accessor: (row) =>
        row.mimeType ? (
          <Badge tone="secondary">{row.mimeType}</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "sizeBytes",
      header: "Size",
      sortable: true,
      accessor: (row) => formatBytes(row.sizeBytes),
    },
    {
      id: "subject",
      header: "Attached to",
      accessor: (row) => {
        const label = subjectLabel(row)
        if (!label) return <span className="text-muted-foreground">—</span>
        const href = subjectHref(row)
        return href ? (
          <Link href={href} className="text-primary hover:underline">
            {label}
          </Link>
        ) : (
          label
        )
      },
    },
  ]
}

export default function FilesListPage() {
  const [rows, setRows] = useState<FileItem[]>([])
  const [pagination, setPagination] = useState<{ nextCursor: string | null; limit: number }>({
    nextCursor: null,
    limit: 25,
  })
  const [cursor, setCursor] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [tree, setTree] = useState<FilterTree>(() => emptyFilterTree())
  const [views, setViews] = useState<SavedViewState[]>([])
  const [activeViewId, setActiveViewId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [bulkWorking, setBulkWorking] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [description, setDescription] = useState("")
  const fileInputRef = useRef<HTMLInputElement>(null)

  const params = useMemo(() => {
    const fromTree = treeToFilesParams(tree)
    const query = search.trim() !== "" ? search.trim() : fromTree.query
    return { query, mimeType: fromTree.mimeType, subjectType: fromTree.subjectType }
  }, [search, tree])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: "25" })
      if (cursor) qs.set("cursor", cursor)
      if (params.query) qs.set("query", params.query)
      if (params.mimeType) qs.set("mimeType", params.mimeType)
      if (params.subjectType) qs.set("subjectType", params.subjectType)
      const res = await apiFetchRaw<FilesListResponse>(`/api/v1/files?${qs.toString()}`)
      setRows(res.data)
      setPagination(res.pagination)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load files.")
    } finally {
      setLoading(false)
    }
  }, [cursor, params.mimeType, params.query, params.subjectType])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setViews(readViews())
    try {
      const url = new URL(window.location.href)
      const encoded = url.searchParams.get("filter")
      if (encoded) setTree(decodeFilterTree(encoded))
      const q = url.searchParams.get("q")
      if (q) setSearch(q)
    } catch {
      // Shareable URLs are best-effort; the list works without them.
    }
  }, [])

  useEffect(() => {
    try {
      const url = new URL(window.location.href)
      url.searchParams.set("filter", encodeFilterTree(tree))
      if (search.trim() !== "") url.searchParams.set("q", search.trim())
      else url.searchParams.delete("q")
      window.history.replaceState(null, "", url.toString())
    } catch {
      // Non-browser render: skip URL persistence.
    }
  }, [tree, search])

  const persistViews = (next: SavedViewState[]) => {
    setViews(next)
    try {
      window.localStorage.setItem(VIEWS_KEY, JSON.stringify(next))
    } catch {
      // Private mode etc: views stay in memory for the session.
    }
  }

  const upload = async (e: React.FormEvent) => {
    e.preventDefault()
    const picked = fileInputRef.current?.files?.[0]
    if (!picked) {
      setUploadError("Choose a file to upload.")
      return
    }
    setUploadError(null)
    setUploading(true)
    try {
      // 1. Mint a presigned PUT URL (validated + permission-checked server-side).
      const { uploadUrl, storageKey } = await apiFetch<UploadUrlResponse>(
        "/api/v1/files/upload-url",
        {
          method: "POST",
          body: {
            fileName: picked.name,
            mimeType: picked.type === "" ? null : picked.type,
            sizeBytes: picked.size,
          },
        },
      )
      // 2. PUT bytes straight to S3/MinIO — never through the API.
      const put = await fetch(uploadUrl, {
        method: "PUT",
        headers: picked.type === "" ? {} : { "content-type": picked.type },
        body: picked,
      })
      if (!put.ok) throw new Error(`Upload failed with status ${put.status}.`)
      // 3. Store metadata only after the bytes land.
      await apiFetch<FileItem>("/api/v1/files", {
        method: "POST",
        body: {
          fileName: picked.name,
          mimeType: picked.type === "" ? null : picked.type,
          sizeBytes: picked.size,
          storageKey,
          ...(description.trim() === "" ? {} : { description: description.trim() }),
        },
      })
      if (fileInputRef.current) fileInputRef.current.value = ""
      setDescription("")
      toast({ title: "File uploaded", description: picked.name })
      await load()
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Upload failed. Try again."
      setUploadError(message)
    } finally {
      setUploading(false)
    }
  }

  const columns = useMemo(() => fileColumns(), [])

  const bulkDelete = async () => {
    setBulkWorking(true)
    try {
      for (const id of selectedIds) {
        await apiFetchRaw(`/api/v1/files/${id}`, { method: "DELETE" })
      }
      setSelectedIds([])
      setConfirmBulkDelete(false)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Bulk delete failed.")
    } finally {
      setBulkWorking(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Files</h1>
      </div>

      <form
        onSubmit={upload}
        className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-panel"
        aria-label="Upload a file"
      >
        <h2 className="text-sm font-semibold">Upload a file</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="File" htmlFor="file-upload" error={uploadError}>
            <input
              id="file-upload"
              ref={fileInputRef}
              type="file"
              className="text-sm"
              aria-label="Choose a file to upload"
            />
          </Field>
          <Field label="Description" htmlFor="file-description">
            <TextField
              id="file-description"
              value={description}
              onChange={(e) => setDescription(e.currentTarget.value)}
              placeholder="What is this file?"
            />
          </Field>
        </div>
        <div>
          <Button type="submit" disabled={uploading}>
            {uploading ? "Uploading…" : "Upload"}
          </Button>
        </div>
        {uploadError !== null ? (
          <ErrorState message={uploadError} onRetry={() => setUploadError(null)} />
        ) : null}
      </form>

      <SavedViews
        views={views}
        activeId={activeViewId}
        onSelect={(id) => {
          const view = views.find((v) => v.id === id)
          if (view) {
            setActiveViewId(id)
            setTree(view.tree)
            setSearch(view.search)
            setCursor(null)
          }
        }}
        onCreate={(name) => {
          const view: SavedViewState = {
            id: crypto.randomUUID(),
            name,
            tree,
            search,
          }
          persistViews([...views, view])
          setActiveViewId(view.id)
        }}
        onRename={(id, name) => persistViews(views.map((v) => (v.id === id ? { ...v, name } : v)))}
        onDelete={(id) => {
          persistViews(views.filter((v) => v.id !== id))
          if (activeViewId === id) setActiveViewId(null)
        }}
      />

      <div className="flex flex-col gap-2">
        <TextField
          value={search}
          onChange={(e) => {
            setSearch(e.currentTarget.value)
            setCursor(null)
          }}
          placeholder="Search files…"
          aria-label="Search files"
          className="max-w-md"
        />
        <FilterBuilder
          value={tree}
          onChange={(next) => {
            setTree(next)
            setCursor(null)
          }}
          fields={FILE_FILTER_FIELDS}
        />
      </div>

      {error !== null ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          getRowId={(row) => row.id}
          selectable
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          loading={loading}
          pagination={{ cursor, ...pagination }}
          onPageChange={(next) => setCursor(next)}
          empty={
            <EmptyState
              title="No files yet"
              description="Upload your first file to attach documents to records."
            />
          }
        />
      )}
      {loading && rows.length === 0 && !error ? (
        <div className="flex flex-col gap-2" aria-hidden="true">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      ) : null}

      <BulkBar selectedCount={selectedIds.length} onClear={() => setSelectedIds([])}>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => setConfirmBulkDelete(true)}
        >
          Delete
        </Button>
      </BulkBar>

      <ConfirmDialog
        open={confirmBulkDelete}
        onOpenChange={setConfirmBulkDelete}
        title={`Delete ${selectedIds.length} files?`}
        description="They move to trash and can be restored from the record page."
        confirmLabel="Delete"
        danger
        loading={bulkWorking}
        onConfirm={() => void bulkDelete()}
      />
    </div>
  )
}
