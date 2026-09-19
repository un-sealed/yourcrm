"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Select,
  Skeleton,
  TextField,
  buttonVariants,
  type DataTableColumn,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import {
  describeReport,
  type Report,
  type ReportObjectCatalogEntry,
  type ReportsListResponse,
} from "./types"

/** Saved reports list: search, object filter, bulk delete, empty/error states. */
export default function ReportsListPage() {
  const [rows, setRows] = useState<Report[]>([])
  const [catalogue, setCatalogue] = useState<ReportObjectCatalogEntry[]>([])
  const [pagination, setPagination] = useState<{ nextCursor: string | null; limit: number }>({
    nextCursor: null,
    limit: 25,
  })
  const [cursor, setCursor] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [objectType, setObjectType] = useState("")
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [working, setWorking] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: "25" })
      if (cursor) qs.set("cursor", cursor)
      if (search.trim() !== "") qs.set("query", search.trim())
      if (objectType !== "") qs.set("objectType", objectType)
      const res = await apiFetchRaw<ReportsListResponse>(`/api/v1/reports?${qs.toString()}`)
      setRows(res.data)
      setPagination(res.pagination)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load reports.")
    } finally {
      setLoading(false)
    }
  }, [cursor, objectType, search])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    apiFetch<ReportObjectCatalogEntry[]>("/api/v1/reports/objects")
      .then(setCatalogue)
      .catch(() => {
        // The catalogue only enriches labels; the list works without it.
      })
  }, [])

  const columns = useMemo<DataTableColumn<Report>[]>(
    () => [
      {
        id: "name",
        header: "Report",
        accessor: (row) => (
          <Link
            href={`/app/reports/${row.id}`}
            className="font-medium text-primary hover:underline"
          >
            {row.name}
          </Link>
        ),
      },
      {
        id: "definition",
        header: "Shows",
        accessor: (row) => (
          <span className="text-muted-foreground">{describeReport(row, catalogue)}</span>
        ),
      },
      {
        id: "visibility",
        header: "Visibility",
        accessor: (row) => (
          <Badge tone={row.visibility === "private" ? "secondary" : "success"}>
            {row.visibility}
          </Badge>
        ),
      },
      {
        id: "lastRun",
        header: "Last run",
        accessor: (row) =>
          row.lastRunAt === null ? (
            <span className="text-muted-foreground">Never</span>
          ) : (
            new Date(row.lastRunAt).toLocaleString()
          ),
      },
    ],
    [catalogue],
  )

  const removeSelected = async () => {
    setWorking(true)
    try {
      for (const id of selectedIds) {
        await apiFetchRaw(`/api/v1/reports/${id}`, { method: "DELETE" })
      }
      setSelectedIds([])
      setConfirmDelete(false)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete the selected reports.")
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Reports</h1>
        <Link href="/app/reports/new" className={buttonVariants()}>
          New report
        </Link>
      </div>

      <div className="flex flex-wrap gap-2">
        <TextField
          value={search}
          onChange={(event) => {
            setSearch(event.currentTarget.value)
            setCursor(null)
          }}
          placeholder="Search reports…"
          aria-label="Search reports"
          className="max-w-md"
        />
        <Select
          aria-label="Filter by object"
          className="w-56"
          value={objectType}
          onChange={(event) => {
            setObjectType(event.currentTarget.value)
            setCursor(null)
          }}
          options={[
            { value: "", label: "All objects" },
            ...catalogue.map((object) => ({ value: object.objectType, label: object.label })),
          ]}
        />
      </div>

      {error !== null ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          getRowId={(row) => row.id}
          ariaLabel="Saved reports"
          selectable
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          loading={loading}
          pagination={{ cursor, ...pagination }}
          onPageChange={(next) => setCursor(next)}
          empty={
            <EmptyState
              title="No reports yet"
              description="Build a report to answer a question about your CRM data — for example open deals by stage."
              action={
                <Link href="/app/reports/new" className={buttonVariants()}>
                  New report
                </Link>
              }
            />
          }
        />
      )}

      {loading && rows.length === 0 && error === null ? (
        <div className="flex flex-col gap-2" aria-hidden="true">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      ) : null}

      {selectedIds.length > 0 ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{selectedIds.length} selected</span>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedIds([])}>
            Clear
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${String(selectedIds.length)} report(s)?`}
        description="They move to trash and can be restored from the record page."
        confirmLabel="Delete"
        danger
        loading={working}
        onConfirm={() => void removeSelected()}
      />
    </div>
  )
}
