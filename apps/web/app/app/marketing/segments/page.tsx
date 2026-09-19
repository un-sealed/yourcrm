"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import {
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Skeleton,
  TextField,
  buttonVariants,
  type DataTableColumn,
} from "@yourcrm/ui"
import { ApiError, apiFetchRaw } from "@/lib/api-client"
import type { MarketingSegment, MarketingSegmentsListResponse } from "../types"

/** Saved segments list: search, delete, empty/error states. */
export default function MarketingSegmentsListPage() {
  const [rows, setRows] = useState<MarketingSegment[]>([])
  const [pagination, setPagination] = useState<{ nextCursor: string | null; limit: number }>({
    nextCursor: null,
    limit: 25,
  })
  const [cursor, setCursor] = useState<string | null>(null)
  const [search, setSearch] = useState("")
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
      const res = await apiFetchRaw<MarketingSegmentsListResponse>(
        `/api/v1/marketing/segments?${qs.toString()}`,
      )
      setRows(res.data)
      setPagination(res.pagination)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load segments.")
    } finally {
      setLoading(false)
    }
  }, [cursor, search])

  useEffect(() => {
    void load()
  }, [load])

  const columns = useMemo<DataTableColumn<MarketingSegment>[]>(
    () => [
      {
        id: "name",
        header: "Segment",
        sortable: true,
        accessor: (row) => (
          <Link
            href={`/app/marketing/segments/${row.id}`}
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
      {
        id: "members",
        header: "Audience",
        align: "right",
        accessor: (row) =>
          row.memberCount === null ? (
            <span className="text-muted-foreground">Not evaluated</span>
          ) : (
            row.memberCount
          ),
      },
    ],
    [],
  )

  const removeSelected = async () => {
    setWorking(true)
    try {
      for (const id of selectedIds) {
        await apiFetchRaw(`/api/v1/marketing/segments/${id}`, { method: "DELETE" })
      }
      setSelectedIds([])
      setConfirmDelete(false)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete the selected segments.")
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Segments</h1>
        <Link href="/app/marketing/segments/new" className={buttonVariants()}>
          New segment
        </Link>
      </div>

      <TextField
        value={search}
        onChange={(event) => {
          setSearch(event.currentTarget.value)
          setCursor(null)
        }}
        placeholder="Search segments…"
        aria-label="Search segments"
        className="max-w-md"
      />

      {error !== null ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          getRowId={(row) => row.id}
          ariaLabel="Marketing segments"
          selectable
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          loading={loading}
          pagination={{ cursor, ...pagination }}
          onPageChange={(next) => setCursor(next)}
          empty={
            <EmptyState
              title="No segments yet"
              description="Build a segment — a saved filter over people — to target a campaign."
              action={
                <Link href="/app/marketing/segments/new" className={buttonVariants()}>
                  New segment
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
        title={`Delete ${String(selectedIds.length)} segment(s)?`}
        description="A campaign already targeting a deleted segment keeps sending; new campaigns cannot pick it."
        confirmLabel="Delete"
        danger
        loading={working}
        onConfirm={() => void removeSelected()}
      />
    </div>
  )
}
