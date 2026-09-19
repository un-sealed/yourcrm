"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  RecordHeader,
  Select,
  Skeleton,
  Tabs,
  TextArea,
  TextField,
  Timeline,
} from "@yourcrm/ui"
import { ApiError, apiFetch } from "@/lib/api-client"

type Job = {
  id: string
  workspaceId: string
  objectType: string
  status: string
  mode?: string
  format: string
  fileName: string | null
  totalRows: number | null
  processedRows?: number | null
  succeededRows?: number | null
  failedRows?: number | null
  skippedRows?: number | null
  createdAt: string
  updatedAt: string
}

const IMPORT_STATUS_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "validating", label: "Validating" },
  { value: "validated", label: "Validated" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "canceled", label: "Canceled" },
]

const EXPORT_STATUS_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "canceled", label: "Canceled" },
]

/** Import/export job detail: header, tabbed overview/timeline, edit, delete. */
export default function ImportExportDetailPage() {
  const params = useParams<{ id: string }>()
  const searchParams = useSearchParams()
  const router = useRouter()
  const id = params.id
  const kind = searchParams.get("kind") === "export" ? "export" : "import"
  const base = kind === "export" ? "exports" : "imports"
  const [job, setJob] = useState<Job | null>(null)
  const [tab, setTab] = useState("overview")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState("pending")
  const [fileName, setFileName] = useState("")
  const [csvText, setCsvText] = useState("")
  const [preview, setPreview] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<Job>(`/api/v1/import-export/${base}/${id}`)
      setJob(data)
      setStatus(data.status)
      setFileName(data.fileName ?? "")
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this job.")
    } finally {
      setLoading(false)
    }
  }, [base, id])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const updated = await apiFetch<Job>(`/api/v1/import-export/${base}/${id}`, {
        method: "PATCH",
        body: {
          status,
          fileName: fileName.trim() === "" ? null : fileName.trim(),
        },
      })
      setJob(updated)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Update failed.")
    } finally {
      setSaving(false)
    }
  }

  const dryRun = async () => {
    if (kind !== "import" || csvText.trim() === "") return
    setSaving(true)
    try {
      const result = await apiFetch<{
        totalRows: number
        validRows: number
        invalidRows: number
      }>(`/api/v1/import-export/imports/${id}/dry-run`, {
        method: "POST",
        body: { csvText },
      })
      setPreview(`${result.totalRows} rows: ${result.validRows} valid, ${result.invalidRows} invalid.`)
    } catch (err) {
      setPreview(err instanceof ApiError ? err.message : "Dry-run failed.")
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    try {
      await apiFetch(`/api/v1/import-export/${base}/${id}`, { method: "DELETE" })
      router.push("/app/import-export")
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Delete failed.")
    }
  }

  const restore = async () => {
    try {
      const restored = await apiFetch<Job>(`/api/v1/import-export/${base}/${id}/restore`, {
        method: "POST",
      })
      setJob(restored)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Restore failed.")
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading job">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (error !== null || job === null) {
    return (
      <ErrorState message={error ?? "This job does not exist."} onRetry={() => void load()} />
    )
  }

  const statusOptions = kind === "export" ? EXPORT_STATUS_OPTIONS : IMPORT_STATUS_OPTIONS

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/import-export" className="text-sm text-muted-foreground hover:underline">
        ← Back to import / export
      </Link>
      <RecordHeader
        title={`${kind === "export" ? "Export" : "Import"} · ${job.objectType}`}
        subtitle={job.fileName ?? "No file attached"}
        status={{ label: job.status, tone: job.status === "completed" ? "success" : "secondary" }}
        owner={undefined}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void restore()}>
              Restore
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </>
        }
      />

      <Tabs
        value={tab}
        onValueChange={setTab}
        ariaLabel="Job sections"
        items={[
          {
            value: "overview",
            label: "Overview",
            content: (
              <div className="grid gap-6 py-4 lg:grid-cols-2">
                <section aria-label="Job properties" className="flex flex-col gap-3">
                  <h2 className="text-sm font-semibold">Properties</h2>
                  <dl className="flex flex-col gap-2 text-sm">
                    <div className="flex items-center gap-2">
                      <dt className="w-28 shrink-0 text-muted-foreground">Object</dt>
                      <dd>{job.objectType}</dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-28 shrink-0 text-muted-foreground">Format</dt>
                      <dd>
                        <Badge tone="secondary">{job.format} (P0)</Badge>
                      </dd>
                    </div>
                    {job.mode ? (
                      <div className="flex items-center gap-2">
                        <dt className="w-28 shrink-0 text-muted-foreground">Mode</dt>
                        <dd>{job.mode}</dd>
                      </div>
                    ) : null}
                    <div className="flex items-center gap-2">
                      <dt className="w-28 shrink-0 text-muted-foreground">Rows</dt>
                      <dd>
                        {job.succeededRows ?? 0}/{job.totalRows ?? 0} ok
                        {(job.failedRows ?? 0) > 0 ? `, ${job.failedRows} failed` : ""}
                        {(job.skippedRows ?? 0) > 0 ? `, ${job.skippedRows} skipped` : ""}
                      </dd>
                    </div>
                  </dl>
                  {kind === "import" ? (
                    <div className="flex flex-col gap-2">
                      <h3 className="text-sm font-semibold">Dry-run preview</h3>
                      <TextArea
                        value={csvText}
                        onChange={(e) => setCsvText(e.currentTarget.value)}
                        aria-label="CSV text for dry-run preview"
                        rows={4}
                        placeholder="first_name,last_name&#10;Ada,Lovelace"
                      />
                      <div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={saving || csvText.trim() === ""}
                          onClick={() => void dryRun()}
                        >
                          {saving ? "Running…" : "Run dry-run"}
                        </Button>
                      </div>
                      {preview !== null ? (
                        <p className="text-sm" role="status">
                          {preview}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <EmptyState
                      title="Permission-aware export"
                      description="This export only includes records visible to its creator."
                    />
                  )}
                </section>
                <section aria-label="Edit job">
                  <h2 className="mb-3 text-sm font-semibold">Edit</h2>
                  <form onSubmit={save} className="flex flex-col gap-3">
                    <Field label="File name" htmlFor="job-file">
                      <TextField
                        id="job-file"
                        value={fileName}
                        onChange={(e) => setFileName(e.currentTarget.value)}
                      />
                    </Field>
                    <Field label="Status" htmlFor="job-status">
                      <Select
                        id="job-status"
                        value={status}
                        onChange={(e) => setStatus(e.currentTarget.value)}
                        options={statusOptions}
                      />
                    </Field>
                    <div>
                      <Button type="submit" disabled={saving}>
                        {saving ? "Saving…" : "Save changes"}
                      </Button>
                    </div>
                  </form>
                </section>
              </div>
            ),
          },
          {
            value: "activity",
            label: "Activity",
            content: (
              <div className="py-4">
                <Timeline
                  items={[
                    {
                      id: "created",
                      actor: "System",
                      timestamp: new Date(job.createdAt).toLocaleString(),
                      dateTime: job.createdAt,
                      body: `Job created (${job.format}).`,
                    },
                    {
                      id: "updated",
                      actor: "System",
                      timestamp: new Date(job.updatedAt).toLocaleString(),
                      dateTime: job.updatedAt,
                      body: `Job last updated (status: ${job.status}).`,
                    },
                  ]}
                />
              </div>
            ),
          },
        ]}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete this ${kind} job?`}
        description="The job moves to trash and can be restored."
        confirmLabel="Delete"
        danger
        onConfirm={() => void remove()}
      />
    </div>
  )
}
