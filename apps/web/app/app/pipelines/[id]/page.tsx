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
  Select,
  Skeleton,
  Tabs,
  TextArea,
  TextField,
  Timeline,
  toast,
} from "@yourcrm/ui"
import { ApiError, apiFetch } from "@/lib/api-client"
import type { PipelineDetail, PipelineStage } from "../page"

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
]

function stageLabel(stage: PipelineStage): string {
  if (stage.isWon) return "Won"
  if (stage.isLost) return "Lost"
  return `${stage.probability}%`
}

/** Pipeline detail: header, stages with drag-to-reorder, edit, delete. */
export default function PipelineDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params.id
  const [pipeline, setPipeline] = useState<PipelineDetail | null>(null)
  const [tab, setTab] = useState("overview")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [status, setStatus] = useState("active")
  const [description, setDescription] = useState("")
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [newStage, setNewStage] = useState("")
  const [dragId, setDragId] = useState<string | null>(null)
  const [reordering, setReordering] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<PipelineDetail>(`/api/v1/pipelines/${id}`)
      setPipeline(data)
      setName(data.name)
      setStatus(data.status)
      setDescription(data.description ?? "")
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this pipeline.")
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const persistOrder = async (orderedIds: string[]) => {
    setReordering(true)
    try {
      const stages = await apiFetch<PipelineStage[]>(`/api/v1/pipelines/${id}/stages/reorder`, {
        method: "POST",
        body: { order: orderedIds },
      })
      setPipeline((prev) => (prev ? { ...prev, stages } : prev))
    } catch (err) {
      toast({
        title: "Reorder failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
      await load()
    } finally {
      setReordering(false)
      setDragId(null)
    }
  }

  const moveStage = (stageId: string, direction: -1 | 1) => {
    if (!pipeline) return
    const ids = pipeline.stages.map((s) => s.id)
    const index = ids.indexOf(stageId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= ids.length) return
    const next = [...ids]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved as string)
    setPipeline({ ...pipeline, stages: orderStages(pipeline.stages, next) })
    void persistOrder(next)
  }

  const onDropStage = (targetId: string) => {
    if (!pipeline || !dragId || dragId === targetId) {
      setDragId(null)
      return
    }
    const ids = pipeline.stages.map((s) => s.id).filter((stageId) => stageId !== dragId)
    const targetIndex = ids.indexOf(targetId)
    ids.splice(targetIndex < 0 ? ids.length : targetIndex, 0, dragId)
    setPipeline({ ...pipeline, stages: orderStages(pipeline.stages, ids) })
    void persistOrder(ids)
  }

  const addStage = async (e: React.FormEvent) => {
    e.preventDefault()
    if (newStage.trim() === "") return
    try {
      const stage = await apiFetch<PipelineStage>(`/api/v1/pipelines/${id}/stages`, {
        method: "POST",
        body: { name: newStage.trim() },
      })
      setPipeline((prev) => (prev ? { ...prev, stages: [...prev.stages, stage] } : prev))
      setNewStage("")
      toast({ title: "Stage added" })
    } catch (err) {
      toast({
        title: "Could not add stage",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  const removeStage = async (stageId: string) => {
    try {
      await apiFetch(`/api/v1/pipelines/${id}/stages/${stageId}`, { method: "DELETE" })
      setPipeline((prev) =>
        prev ? { ...prev, stages: prev.stages.filter((s) => s.id !== stageId) } : prev,
      )
    } catch (err) {
      toast({
        title: "Could not remove stage",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const updated = await apiFetch<PipelineDetail>(`/api/v1/pipelines/${id}`, {
        method: "PATCH",
        body: {
          name: name.trim(),
          status,
          description: description.trim() === "" ? null : description.trim(),
        },
      })
      setPipeline(updated)
      toast({ title: "Pipeline updated" })
    } catch (err) {
      toast({
        title: "Update failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    try {
      await apiFetch(`/api/v1/pipelines/${id}`, { method: "DELETE" })
      toast({ title: "Pipeline deleted", description: "It can be restored from trash." })
      router.push("/app/pipelines")
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading pipeline">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (error !== null || pipeline === null) {
    return (
      <ErrorState message={error ?? "This pipeline does not exist."} onRetry={() => void load()} />
    )
  }

  const won = pipeline.stages.filter((s) => s.isWon).length
  const lost = pipeline.stages.filter((s) => s.isLost).length

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/pipelines" className="text-sm text-muted-foreground hover:underline">
        ← Back to pipelines
      </Link>
      <RecordHeader
        title={pipeline.name}
        subtitle={
          pipeline.description ?? `${pipeline.stages.length} stages · ${won} won · ${lost} lost`
        }
        status={{
          label: pipeline.status,
          tone: pipeline.status === "active" ? "success" : "secondary",
        }}
        owner={undefined}
        actions={
          <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        }
      />

      <Tabs
        value={tab}
        onValueChange={setTab}
        ariaLabel="Pipeline sections"
        items={[
          {
            value: "overview",
            label: "Overview",
            content: (
              <div className="grid gap-6 py-4 lg:grid-cols-2">
                <section aria-label="Stages" className="flex flex-col gap-3">
                  <h2 className="text-sm font-semibold">Stages (drag to reorder)</h2>
                  {pipeline.stages.length === 0 ? (
                    <EmptyState
                      title="No stages yet"
                      description="Add the first stage below to model this process."
                    />
                  ) : (
                    <ol className="flex flex-col gap-2" aria-label="Pipeline stages">
                      {pipeline.stages.map((stage, index) => (
                        <li
                          key={stage.id}
                          draggable
                          onDragStart={() => setDragId(stage.id)}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={() => onDropStage(stage.id)}
                          className="flex items-center gap-2 rounded-md border border-border p-2 text-sm"
                          aria-label={`Stage ${index + 1}: ${stage.name}`}
                        >
                          <span
                            className="cursor-grab text-muted-foreground"
                            aria-hidden="true"
                            title="Drag to reorder"
                          >
                            ⋮⋮
                          </span>
                          <span className="font-medium">{stage.name}</span>
                          <Badge tone={stage.isWon || stage.isLost ? "success" : "secondary"}>
                            {stageLabel(stage)}
                          </Badge>
                          <span className="ml-auto flex items-center gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={`Move ${stage.name} up`}
                              disabled={index === 0 || reordering}
                              onClick={() => moveStage(stage.id, -1)}
                            >
                              ↑
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={`Move ${stage.name} down`}
                              disabled={index === pipeline.stages.length - 1 || reordering}
                              onClick={() => moveStage(stage.id, 1)}
                            >
                              ↓
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={`Remove ${stage.name}`}
                              onClick={() => void removeStage(stage.id)}
                            >
                              ✕
                            </Button>
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                  <form onSubmit={addStage} className="flex items-center gap-2">
                    <TextField
                      value={newStage}
                      onChange={(e) => setNewStage(e.currentTarget.value)}
                      placeholder="New stage name…"
                      aria-label="New stage name"
                      className="max-w-xs"
                    />
                    <Button type="submit" size="sm">
                      Add stage
                    </Button>
                  </form>
                </section>
                <section aria-label="Edit pipeline">
                  <h2 className="mb-3 text-sm font-semibold">Edit</h2>
                  <form onSubmit={save} className="flex flex-col gap-3">
                    <Field label="Name" htmlFor="pipeline-name">
                      <TextField
                        id="pipeline-name"
                        value={name}
                        onChange={(e) => setName(e.currentTarget.value)}
                      />
                    </Field>
                    <Field label="Status" htmlFor="pipeline-status">
                      <Select
                        id="pipeline-status"
                        value={status}
                        onChange={(e) => setStatus(e.currentTarget.value)}
                        options={STATUS_OPTIONS}
                      />
                    </Field>
                    <Field label="Description" htmlFor="pipeline-description">
                      <TextArea
                        id="pipeline-description"
                        value={description}
                        onChange={(e) => setDescription(e.currentTarget.value)}
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
                      timestamp: new Date(pipeline.createdAt).toLocaleString(),
                      dateTime: pipeline.createdAt,
                      body: "Pipeline created.",
                    },
                    {
                      id: "updated",
                      actor: "System",
                      timestamp: new Date(pipeline.updatedAt).toLocaleString(),
                      dateTime: pipeline.updatedAt,
                      body: "Pipeline last updated.",
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
        title={`Delete ${pipeline.name}?`}
        description="The pipeline moves to trash and can be restored."
        confirmLabel="Delete"
        danger
        onConfirm={() => void remove()}
      />
    </div>
  )
}

function orderStages(stages: PipelineStage[], orderedIds: string[]): PipelineStage[] {
  const byId = new Map(stages.map((s) => [s.id, s]))
  return orderedIds.flatMap((id, position) => {
    const stage = byId.get(id)
    return stage ? [{ ...stage, position }] : []
  })
}
