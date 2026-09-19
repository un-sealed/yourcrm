"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import {
  Badge,
  BulkBar,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Select,
  Skeleton,
  TextArea,
  TextField,
  type DataTableColumn,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"

type ImportJob = {
  id: string
  workspaceId: string
  objectType: string
  status: string
  mode: string
  format: string
  fileName: string | null
  totalRows: number | null
  processedRows: number | null
  succeededRows: number | null
  failedRows: number | null
  skippedRows: number | null
  createdAt: string
  updatedAt: string
}

type ExportJob = {
  id: string
  workspaceId: string
  objectType: string
  status: string
  format: string
  fileName: string | null
  totalRows: number | null
  createdAt: string
  updatedAt: string
}

type ListResponse<T> = {
  data: T[]
  pagination: { nextCursor: string | null; limit: number }
}

type DryRunPreview = {
  totalRows: number
  validRows: number
  invalidRows: number
  missingColumns: string[]
  errors: { row: number; column: string | null; message: string }[]
}

const OBJECT_OPTIONS = [
  { value: "person", label: "People" },
  { value: "company", label: "Companies" },
  { value: "lead", label: "Leads" },
  { value: "deal", label: "Deals" },
]

const MODE_OPTIONS = [
  { value: "create", label: "Create" },
  { value: "update", label: "Update" },
  { value: "upsert", label: "Upsert" },
]

function statusTone(status: string): "success" | "secondary" | "destructive" {
  if (status === "completed" || status === "validated") return "success"
  if (status === "failed") return "destructive"
  return "secondary"
}

function importColumns(): DataTableColumn<ImportJob>[] {
  return [
    {
      id: "object",
      header: "Object",
      sortable: true,
      accessor: (row) => (
        <Link
          href={`/app/import-export/${row.id}?kind=import`}
          className="font-medium text-primary hover:underline"
        >
          {row.objectType}
        </Link>
      ),
    },
    {
      id: "file",
      header: "File",
      accessor: (row) => row.fileName ?? <span className="text-muted-foreground">—</span>,
    },
    {
      id: "mode",
      header: "Mode",
      accessor: (row) => row.mode,
    },
    {
      id: "status",
      header: "Status",
      accessor: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
    },
    {
      id: "progress",
      header: "Rows",
      accessor: (row) =>
        `${row.succeededRows ?? 0}/${row.totalRows ?? 0} ok${(row.failedRows ?? 0) > 0 ? `, ${row.failedRows} failed` : ""}`,
    },
  ]
}

function exportColumns(): DataTableColumn<ExportJob>[] {
  return [
    {
      id: "object",
      header: "Object",
      sortable: true,
      accessor: (row) => (
        <Link
          href={`/app/import-export/${row.id}?kind=export`}
          className="font-medium text-primary hover:underline"
        >
          {row.objectType}
        </Link>
      ),
    },
    {
      id: "file",
      header: "File",
      accessor: (row) => row.fileName ?? <span className="text-muted-foreground">—</span>,
    },
    {
      id: "status",
      header: "Status",
      accessor: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
    },
  ]
}

export default function ImportExportListPage() {
  const [imports, setImports] = useState<ImportJob[]>([])
  const [exports, setExports] = useState<ExportJob[]>([])
  const [tab, setTab] = useState<"imports" | "exports">("imports")
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("")
  const [objectType, setObjectType] = useState("person")
  const [mode, setMode] = useState("create")
  const [fileName, setFileName] = useState("")
  const [exportObjectType, setExportObjectType] = useState("person")
  const [exportFileName, setExportFileName] = useState("")
  const [csvText, setCsvText] = useState("first_name,last_name\nAda,Lovelace\n")
  const [preview, setPreview] = useState<DryRunPreview | null>(null)
  const [previewJobId, setPreviewJobId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: "25" })
      if (search.trim() !== "") qs.set("query", search.trim())
      if (status !== "") qs.set("status", status)
      const [importRes, exportRes] = await Promise.all([
        apiFetchRaw<ListResponse<ImportJob>>(`/api/v1/import-export/imports?${qs.toString()}`),
        apiFetchRaw<ListResponse<ExportJob>>(`/api/v1/import-export/exports?${qs.toString()}`),
      ])
      setImports(importRes.data)
      setExports(exportRes.data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load import/export jobs.")
    } finally {
      setLoading(false)
    }
  }, [search, status])

  useEffect(() => {
    void load()
  }, [load])

  const createImport = async (e: React.FormEvent) => {
    e.preventDefault()
    setWorking(true)
    try {
      await apiFetch<ImportJob>("/api/v1/import-export/imports", {
        method: "POST",
        body: {
          objectType,
          mode,
          ...(fileName.trim() === "" ? {} : { fileName: fileName.trim() }),
        },
      })
      setFileName("")
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the import job.")
    } finally {
      setWorking(false)
    }
  }

  const createExport = async (e: React.FormEvent) => {
    e.preventDefault()
    setWorking(true)
    try {
      await apiFetch<ExportJob>("/api/v1/import-export/exports", {
        method: "POST",
        body: {
          objectType: exportObjectType,
          ...(exportFileName.trim() === "" ? {} : { fileName: exportFileName.trim() }),
        },
      })
      setExportFileName("")
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the export job.")
    } finally {
      setWorking(false)
    }
  }

  const runDryRun = async (jobId: string) => {
    setWorking(true)
    try {
      const result = await apiFetch<DryRunPreview>(
        `/api/v1/import-export/imports/${jobId}/dry-run`,
        { method: "POST", body: { csvText } },
      )
      setPreview(result)
      setPreviewJobId(jobId)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Dry-run preview failed.")
    } finally {
      setWorking(false)
    }
  }

  const bulkDelete = async () => {
    setWorking(true)
    try {
      const base = tab === "imports" ? "imports" : "exports"
      for (const id of selectedIds) {
        await apiFetchRaw(`/api/v1/import-export/${base}/${id}`, { method: "DELETE" })
      }
      setSelectedIds([])
      setConfirmBulkDelete(false)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Bulk delete failed.")
    } finally {
      setWorking(false)
    }
  }

  const importCols = useMemo(() => importColumns(), [])
  const exportCols = useMemo(() => exportColumns(), [])
  const rows = tab === "imports" ? imports : exports

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Import / Export</h1>
        <div className="flex gap-2" role="tablist" aria-label="Job type">
          <Button
            type="button"
            variant={tab === "imports" ? "default" : "outline"}
            size="sm"
            role="tab"
            aria-selected={tab === "imports"}
            onClick={() => {
              setTab("imports")
              setSelectedIds([])
            }}
          >
            Imports
          </Button>
          <Button
            type="button"
            variant={tab === "exports" ? "default" : "outline"}
            size="sm"
            role="tab"
            aria-selected={tab === "exports"}
            onClick={() => {
              setTab("exports")
              setSelectedIds([])
            }}
          >
            Exports
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <form
          onSubmit={createImport}
          aria-label="New CSV import"
          className="flex flex-col gap-2 rounded-md border p-4"
        >
          <h2 className="text-sm font-semibold">New CSV import</h2>
          <label className="flex flex-col gap-1 text-sm">
            Object type
            <Select
              value={objectType}
              onChange={(e) => setObjectType(e.currentTarget.value)}
              options={OBJECT_OPTIONS}
              aria-label="Import object type"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Mode
            <Select
              value={mode}
              onChange={(e) => setMode(e.currentTarget.value)}
              options={MODE_OPTIONS}
              aria-label="Import mode"
            />
          </label>
          <TextField
            value={fileName}
            onChange={(e) => setFileName(e.currentTarget.value)}
            placeholder="people.csv (optional)"
            aria-label="Import file name"
          />
          <div>
            <Button type="submit" size="sm" disabled={working}>
              {working ? "Creating…" : "Create import job"}
            </Button>
          </div>
        </form>

        <form
          onSubmit={createExport}
          aria-label="New CSV export"
          className="flex flex-col gap-2 rounded-md border p-4"
        >
          <h2 className="text-sm font-semibold">New CSV export</h2>
          <label className="flex flex-col gap-1 text-sm">
            Object type
            <Select
              value={exportObjectType}
              onChange={(e) => setExportObjectType(e.currentTarget.value)}
              options={OBJECT_OPTIONS}
              aria-label="Export object type"
            />
          </label>
          <TextField
            value={exportFileName}
            onChange={(e) => setExportFileName(e.currentTarget.value)}
            placeholder="people-export.csv (optional)"
            aria-label="Export file name"
          />
          <div>
            <Button type="submit" size="sm" disabled={working}>
              {working ? "Creating…" : "Create export job"}
            </Button>
          </div>
        </form>
      </div>

      <div className="flex flex-col gap-2 rounded-md border p-4">
        <h2 className="text-sm font-semibold">Dry-run validation preview (CSV)</h2>
        <TextArea
          value={csvText}
          onChange={(e) => setCsvText(e.currentTarget.value)}
          aria-label="CSV text for dry-run preview"
          rows={4}
        />
        <p className="text-xs text-muted-foreground">
          Pick an import job below, then run the preview. Only CSV is supported in P0.
        </p>
        {preview !== null ? (
          <div className="text-sm" role="status">
            <p>
              {preview.totalRows} rows: {preview.validRows} valid, {preview.invalidRows} invalid
              {previewJobId ? ` (job ${previewJobId.slice(0, 8)}…)` : ""}.
            </p>
            {preview.missingColumns.length > 0 ? (
              <p>Missing columns: {preview.missingColumns.join(", ")}</p>
            ) : null}
            {preview.errors.length > 0 ? (
              <ul className="list-disc pl-5">
                {preview.errors.slice(0, 5).map((e, i) => (
                  <li key={`${e.row}-${e.column ?? "?"}-${i}`}>
                    Row {e.row}{e.column ? ` (${e.column})` : ""}: {e.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <TextField
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          placeholder="Search jobs…"
          aria-label="Search import/export jobs"
          className="max-w-md"
        />
        <TextField
          value={status}
          onChange={(e) => setStatus(e.currentTarget.value)}
          placeholder="Filter by status (e.g. pending)"
          aria-label="Filter jobs by status"
          className="max-w-xs"
        />
      </div>

      {error !== null ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : tab === "imports" ? (
        <DataTable
          rows={imports}
          columns={importCols}
          getRowId={(row) => row.id}
          selectable
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          loading={loading}
          empty={
            <EmptyState
              title="No imports yet"
              description="Create your first CSV import job to migrate records from a spreadsheet."
              action={
                <span className="text-sm text-muted-foreground">
                  Use the form above to start an import.
                </span>
              }
            />
          }
        />
      ) : (
        <DataTable
          rows={exports}
          columns={exportCols}
          getRowId={(row) => row.id}
          selectable
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          loading={loading}
          empty={
            <EmptyState
              title="No exports yet"
              description="Create your first CSV export job. Exports only include records you can see."
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

      {tab === "imports" && imports.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {imports.slice(0, 3).map((job) => (
            <Button
              key={job.id}
              type="button"
              variant="outline"
              size="sm"
              disabled={working}
              onClick={() => void runDryRun(job.id)}
            >
              Preview {job.objectType} CSV
            </Button>
          ))}
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
        title={`Delete ${selectedIds.length} ${tab}?`}
        description="They move to trash and can be restored from the record page."
        confirmLabel="Delete"
        danger
        loading={working}
        onConfirm={() => void bulkDelete()}
      />
    </div>
  )
}
