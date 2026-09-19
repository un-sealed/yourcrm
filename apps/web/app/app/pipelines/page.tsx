"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  Badge,
  BulkBar,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  Select,
  Skeleton,
  TextField,
  type DataTableColumn,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"

export type PipelineStage = {
  id: string
  pipelineId: string
  name: string
  color: string | null
  position: number
  probability: number
  isWon: boolean
  isLost: boolean
}

export type Pipeline = {
  id: string
  workspaceId: string
  name: string
  description: string | null
  ownerId: string | null
  status: string
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

export type PipelineDetail = Pipeline & {
  stages: PipelineStage[]
}

export type PipelinesListResponse = {
  data: Pipeline[]
  pagination: { nextCursor: string | null; limit: number }
}

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
]

const SORT_OPTIONS = [
  { value: "desc", label: "Newest first" },
  { value: "asc", label: "Oldest first" },
]

function pipelineColumns(): DataTableColumn<Pipeline>[] {
  return [
    {
      id: "name",
      header: "Name",
      sortable: true,
      accessor: (row) => (
        <span className="flex items-center gap-2">
          <Link
            href={`/app/pipelines/${row.id}`}
            className="font-medium text-primary hover:underline"
          >
            {row.name}
          </Link>
          {row.isDefault ? <Badge tone="secondary">Default</Badge> : null}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      accessor: (row) => (
        <Badge tone={row.status === "active" ? "success" : "secondary"}>{row.status}</Badge>
      ),
    },
    {
      id: "description",
      header: "Description",
      accessor: (row) => row.description ?? <span className="text-muted-foreground">—</span>,
    },
  ]
}

export default function PipelinesListPage() {
  const router = useRouter()
  const [rows, setRows] = useState<Pipeline[]>([])
  const [pagination, setPagination] = useState<{ nextCursor: string | null; limit: number }>({
    nextCursor: null,
    limit: 25,
  })
  const [cursor, setCursor] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("")
  const [order, setOrder] = useState("desc")
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [bulkWorking, setBulkWorking] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState("")
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: "25", order })
      if (cursor) qs.set("cursor", cursor)
      if (search.trim() !== "") qs.set("query", search.trim())
      if (status !== "") qs.set("status", status)
      const res = await apiFetchRaw<PipelinesListResponse>(`/api/v1/pipelines?${qs.toString()}`)
      setRows(res.data)
      setPagination(res.pagination)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load pipelines.")
    } finally {
      setLoading(false)
    }
  }, [cursor, search, status, order])

  useEffect(() => {
    void load()
  }, [load])

  const inlineCommit = useCallback(
    async (rowId: string, patch: Partial<Pipeline>) => {
      try {
        const updated = await apiFetch<Pipeline>(`/api/v1/pipelines/${rowId}`, {
          method: "PATCH",
          body: patch,
        })
        setRows((prev) => prev.map((row) => (row.id === rowId ? updated : row)))
      } catch {
        void load()
      }
    },
    [load],
  )

  const columns = useMemo(() => pipelineColumns(), [])

  const bulkDelete = async () => {
    setBulkWorking(true)
    try {
      for (const id of selectedIds) {
        await apiFetchRaw(`/api/v1/pipelines/${id}`, { method: "DELETE" })
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

  const createPipeline = async (e: React.FormEvent) => {
    e.preventDefault()
    if (createName.trim() === "") {
      setCreateError("Name is required.")
      return
    }
    setCreateError(null)
    setCreating(true)
    try {
      const created = await apiFetch<Pipeline>("/api/v1/pipelines", {
        method: "POST",
        body: { name: createName.trim() },
      })
      router.push(`/app/pipelines/${created.id}`)
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create the pipeline.")
      setCreating(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Pipelines</h1>
        <Button type="button" onClick={() => setShowCreate((v) => !v)}>
          New pipeline
        </Button>
      </div>

      {showCreate ? (
        <form
          onSubmit={createPipeline}
          className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3"
        >
          <Field label="Pipeline name" htmlFor="new-pipeline-name" error={createError}>
            <TextField
              id="new-pipeline-name"
              value={createName}
              onChange={(e) => setCreateName(e.currentTarget.value)}
              placeholder="Sales Pipeline"
            />
          </Field>
          <Button type="submit" disabled={creating}>
            {creating ? "Creating…" : "Create pipeline"}
          </Button>
        </form>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <TextField
          value={search}
          onChange={(e) => {
            setSearch(e.currentTarget.value)
            setCursor(null)
          }}
          placeholder="Search pipelines…"
          aria-label="Search pipelines"
          className="max-w-md"
        />
        <Select
          value={status}
          onChange={(e) => {
            setStatus(e.currentTarget.value)
            setCursor(null)
          }}
          options={STATUS_OPTIONS}
          aria-label="Filter by status"
        />
        <Select
          value={order}
          onChange={(e) => {
            setOrder(e.currentTarget.value)
            setCursor(null)
          }}
          options={SORT_OPTIONS}
          aria-label="Sort pipelines"
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
          onRowCommit={(rowId, patch) => void inlineCommit(rowId, patch)}
          pagination={{ cursor, ...pagination }}
          onPageChange={(next) => setCursor(next)}
          empty={
            <EmptyState
              title="No pipelines yet"
              description="Create your first pipeline to model a sales or delivery process."
              action={
                <Button type="button" onClick={() => setShowCreate(true)}>
                  New pipeline
                </Button>
              }
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
        title={`Delete ${selectedIds.length} pipelines?`}
        description="They move to trash and can be restored from the record page."
        confirmLabel="Delete"
        danger
        loading={bulkWorking}
        onConfirm={() => void bulkDelete()}
      />
    </div>
  )
}
