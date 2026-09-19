"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  BulkBar,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  Skeleton,
  TextField,
  type DataTableColumn,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import type { Dashboard, DashboardsListResponse } from "./types"

function dashboardColumns(): DataTableColumn<Dashboard>[] {
  return [
    {
      id: "name",
      header: "Name",
      sortable: true,
      accessor: (row) => (
        <Link
          href={`/app/dashboards/${row.id}`}
          className="font-medium text-primary hover:underline"
        >
          {row.name}
        </Link>
      ),
    },
    {
      id: "description",
      header: "Description",
      accessor: (row) => row.description ?? <span className="text-muted-foreground">—</span>,
    },
  ]
}

/** Dashboards list: mirrors the pipelines list (inline create, no status field). */
export default function DashboardsListPage() {
  const router = useRouter()
  const [rows, setRows] = useState<Dashboard[]>([])
  const [pagination, setPagination] = useState<{ nextCursor: string | null; limit: number }>({
    nextCursor: null,
    limit: 25,
  })
  const [cursor, setCursor] = useState<string | null>(null)
  const [search, setSearch] = useState("")
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
      const qs = new URLSearchParams({ limit: "25" })
      if (cursor) qs.set("cursor", cursor)
      if (search.trim() !== "") qs.set("query", search.trim())
      const res = await apiFetchRaw<DashboardsListResponse>(`/api/v1/dashboards?${qs.toString()}`)
      setRows(res.data)
      setPagination(res.pagination)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load dashboards.")
    } finally {
      setLoading(false)
    }
  }, [cursor, search])

  useEffect(() => {
    void load()
  }, [load])

  const inlineCommit = useCallback(
    async (rowId: string, patch: Partial<Dashboard>) => {
      try {
        const updated = await apiFetch<Dashboard>(`/api/v1/dashboards/${rowId}`, {
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

  const columns = useMemo(() => dashboardColumns(), [])

  const bulkDelete = async () => {
    setBulkWorking(true)
    try {
      for (const id of selectedIds) {
        await apiFetchRaw(`/api/v1/dashboards/${id}`, { method: "DELETE" })
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

  const createDashboard = async (e: React.FormEvent) => {
    e.preventDefault()
    if (createName.trim() === "") {
      setCreateError("Name is required.")
      return
    }
    setCreateError(null)
    setCreating(true)
    try {
      const created = await apiFetch<Dashboard>("/api/v1/dashboards", {
        method: "POST",
        body: { name: createName.trim() },
      })
      router.push(`/app/dashboards/${created.id}`)
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create the dashboard.")
      setCreating(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Dashboards</h1>
        <Button type="button" onClick={() => setShowCreate((v) => !v)}>
          New dashboard
        </Button>
      </div>

      {showCreate ? (
        <form
          onSubmit={createDashboard}
          className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3"
        >
          <Field label="Dashboard name" htmlFor="new-dashboard-name" error={createError}>
            <TextField
              id="new-dashboard-name"
              value={createName}
              onChange={(e) => setCreateName(e.currentTarget.value)}
              placeholder="Sales Overview"
            />
          </Field>
          <Button type="submit" disabled={creating}>
            {creating ? "Creating…" : "Create dashboard"}
          </Button>
        </form>
      ) : null}

      <TextField
        value={search}
        onChange={(e) => {
          setSearch(e.currentTarget.value)
          setCursor(null)
        }}
        placeholder="Search dashboards…"
        aria-label="Search dashboards"
        className="max-w-md"
      />

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
              title="No dashboards yet"
              description="Create a dashboard, then add metric, table, bar or line widgets to visualize your data."
              action={
                <Button type="button" onClick={() => setShowCreate(true)}>
                  New dashboard
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
        title={`Delete ${selectedIds.length} dashboards?`}
        description="They move to trash and can be restored from the record page."
        confirmLabel="Delete"
        danger
        loading={bulkWorking}
        onConfirm={() => void bulkDelete()}
      />
    </div>
  )
}
