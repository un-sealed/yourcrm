"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  RecordHeader,
  Skeleton,
  Tabs,
  TextArea,
  TextField,
  Timeline,
  toast,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import { formatBytes, subjectHref, subjectLabel, type FileItem } from "../_components/types"

/** File detail: header, tabbed overview/timeline, inline edit, delete. */
export default function FileDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params.id
  const [file, setFile] = useState<FileItem | null>(null)
  const [tab, setTab] = useState("overview")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fileName, setFileName] = useState("")
  const [description, setDescription] = useState("")
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<FileItem>(`/api/v1/files/${id}`)
      setFile(data)
      setFileName(data.fileName)
      setDescription(data.description ?? "")
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this file.")
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (fileName.trim() === "") {
      toast({ title: "Update failed", description: "File name must not be empty." })
      return
    }
    setSaving(true)
    try {
      const updated = await apiFetch<FileItem>(`/api/v1/files/${id}`, {
        method: "PATCH",
        body: {
          fileName: fileName.trim(),
          description: description.trim() === "" ? null : description.trim(),
        },
      })
      setFile(updated)
      toast({ title: "File updated" })
    } catch (err) {
      toast({
        title: "Update failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setSaving(false)
    }
  }

  const download = async () => {
    try {
      const data = await apiFetch<{ downloadUrl: string }>(`/api/v1/files/${id}/download-url`)
      window.location.assign(data.downloadUrl)
    } catch (err) {
      toast({
        title: "Download failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  const remove = async () => {
    try {
      await apiFetch(`/api/v1/files/${id}`, { method: "DELETE" })
      toast({ title: "File deleted", description: "It can be restored from trash." })
      router.push("/app/files")
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  const restore = async () => {
    try {
      const restored = await apiFetchRaw<{ data: FileItem }>(`/api/v1/files/${id}/restore`, {
        method: "POST",
      })
      setFile(restored.data)
      toast({ title: "File restored" })
    } catch (err) {
      toast({
        title: "Restore failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading file">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (error !== null || file === null) {
    return <ErrorState message={error ?? "This file does not exist."} onRetry={() => void load()} />
  }

  const attachedLabel = subjectLabel(file)
  const attachedHref = subjectHref(file)

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/files" className="text-sm text-muted-foreground hover:underline">
        ← Back to files
      </Link>
      <RecordHeader
        title={file.fileName}
        subtitle={file.mimeType ?? "Unknown type"}
        status={{ label: formatBytes(file.sizeBytes), tone: "secondary" }}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void download()}>
              Download
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
        ariaLabel="File sections"
        items={[
          {
            value: "overview",
            label: "Overview",
            content: (
              <div className="grid gap-6 py-4 lg:grid-cols-2">
                <section aria-label="File properties" className="flex flex-col gap-3">
                  <h2 className="text-sm font-semibold">Properties</h2>
                  <dl className="flex flex-col gap-2 text-sm">
                    <div className="flex items-center gap-2">
                      <dt className="w-24 shrink-0 text-muted-foreground">Type</dt>
                      <dd>
                        {file.mimeType ? <Badge tone="secondary">{file.mimeType}</Badge> : "—"}
                      </dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-24 shrink-0 text-muted-foreground">Size</dt>
                      <dd>{formatBytes(file.sizeBytes)}</dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-24 shrink-0 text-muted-foreground">Storage key</dt>
                      <dd className="break-all font-mono text-xs">{file.storageKey}</dd>
                    </div>
                  </dl>
                  {file.description ? (
                    <div className="flex flex-col gap-1">
                      <h3 className="text-sm font-semibold">Description</h3>
                      <p className="whitespace-pre-wrap text-sm">{file.description}</p>
                    </div>
                  ) : null}
                </section>
                <section aria-label="Related records" className="flex flex-col gap-3">
                  <h2 className="text-sm font-semibold">Related records</h2>
                  {attachedLabel && attachedHref ? (
                    <p className="text-sm">
                      Attached to{" "}
                      <Link href={attachedHref} className="text-primary hover:underline">
                        {attachedLabel}
                      </Link>
                    </p>
                  ) : (
                    <EmptyState
                      title="No related records"
                      description="This file is stored at the workspace level and is not attached to a person, company or deal."
                    />
                  )}
                  <h2 className="text-sm font-semibold">Edit</h2>
                  <form onSubmit={save} className="flex flex-col gap-3">
                    <Field label="File name" htmlFor="file-name">
                      <TextField
                        id="file-name"
                        value={fileName}
                        onChange={(e) => setFileName(e.currentTarget.value)}
                      />
                    </Field>
                    <Field label="Description" htmlFor="file-description">
                      <TextArea
                        id="file-description"
                        value={description}
                        onChange={(e) => setDescription(e.currentTarget.value)}
                      />
                    </Field>
                    <div className="flex gap-2">
                      <Button type="submit" disabled={saving}>
                        {saving ? "Saving…" : "Save changes"}
                      </Button>
                      <Button type="button" variant="outline" onClick={() => void restore()}>
                        Restore
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
                      timestamp: new Date(file.createdAt).toLocaleString(),
                      dateTime: file.createdAt,
                      body: "File uploaded.",
                    },
                    {
                      id: "updated",
                      actor: "System",
                      timestamp: new Date(file.updatedAt).toLocaleString(),
                      dateTime: file.updatedAt,
                      body: "File last updated.",
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
        title={`Delete ${file.fileName}?`}
        description="The file moves to trash and can be restored."
        confirmLabel="Delete"
        danger
        onConfirm={() => void remove()}
      />
    </div>
  )
}
