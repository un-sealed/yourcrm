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
  FilterBuilder,
  SavedViews,
  Skeleton,
  TextField,
  buttonVariants,
  decodeFilterTree,
  emptyFilterTree,
  encodeFilterTree,
  type DataTableColumn,
  type FilterTree,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import type { CompaniesListResponse, Company } from "./types"
import { COMPANY_FILTER_FIELDS } from "./types"
import { treeToCompaniesParams } from "./filters"

type SavedViewState = { id: string; name: string; tree: FilterTree; search: string }

const VIEWS_KEY = "yourcrm.companies.views"

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

function companyColumns(): DataTableColumn<Company>[] {
  return [
    {
      id: "name",
      header: "Name",
      sortable: true,
      accessor: (row) => (
        <Link
          href={`/app/companies/${row.id}`}
          className="font-medium text-primary hover:underline"
        >
          {row.name}
        </Link>
      ),
    },
    {
      id: "domain",
      header: "Domain",
      sortable: true,
      accessor: (row) => row.domain ?? <span className="text-muted-foreground">—</span>,
    },
    {
      id: "industry",
      header: "Industry",
      sortable: true,
      accessor: (row) => row.industry ?? <span className="text-muted-foreground">—</span>,
      renderEdit: ({ row, onCommit, onCancel }) => (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const value = new FormData(e.currentTarget).get("industry")
            onCommit({ industry: typeof value === "string" && value !== "" ? value : null })
          }}
          className="flex items-center gap-1"
        >
          <TextField
            name="industry"
            defaultValue={row.industry ?? ""}
            aria-label="Edit industry"
            className="h-7 text-xs"
          />
          <Button type="submit" size="sm" className="h-7 px-2 text-xs">
            Save
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={onCancel}
          >
            ✕
          </Button>
        </form>
      ),
    },
    {
      id: "size",
      header: "Size",
      accessor: (row) => row.size ?? <span className="text-muted-foreground">—</span>,
    },
    {
      id: "status",
      header: "Status",
      accessor: (row) => (
        <Badge tone={row.status === "active" ? "success" : "secondary"}>{row.status}</Badge>
      ),
    },
  ]
}

export default function CompaniesListPage() {
  const [rows, setRows] = useState<Company[]>([])
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

  const params = useMemo(() => {
    const fromTree = treeToCompaniesParams(tree)
    const query = search.trim() !== "" ? search.trim() : fromTree.query
    return { query, status: fromTree.status, industry: fromTree.industry }
  }, [search, tree])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: "25" })
      if (cursor) qs.set("cursor", cursor)
      if (params.query) qs.set("query", params.query)
      if (params.status) qs.set("status", params.status)
      if (params.industry) qs.set("industry", params.industry)
      const res = await apiFetchRaw<CompaniesListResponse>(`/api/v1/companies?${qs.toString()}`)
      setRows(res.data)
      setPagination(res.pagination)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load companies.")
    } finally {
      setLoading(false)
    }
  }, [cursor, params.query, params.status, params.industry])

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

  const inlineCommit = useCallback(
    async (rowId: string, patch: Partial<Company>) => {
      try {
        const updated = await apiFetch<Company>(`/api/v1/companies/${rowId}`, {
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

  const columns = useMemo(() => companyColumns(), [])

  const bulkDelete = async () => {
    setBulkWorking(true)
    try {
      for (const id of selectedIds) {
        await apiFetchRaw(`/api/v1/companies/${id}`, { method: "DELETE" })
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
        <h1 className="text-xl font-semibold">Companies</h1>
        <Link href="/app/companies/new" className={buttonVariants()}>
          New company
        </Link>
      </div>

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
          placeholder="Search companies…"
          aria-label="Search companies"
          className="max-w-md"
        />
        <FilterBuilder
          value={tree}
          onChange={(next) => {
            setTree(next)
            setCursor(null)
          }}
          fields={COMPANY_FILTER_FIELDS}
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
              title="No companies yet"
              description="Add your first account to start building the pipeline."
              action={
                <Link href="/app/companies/new" className={buttonVariants()}>
                  New company
                </Link>
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
        title={`Delete ${selectedIds.length} companies?`}
        description="They move to trash and can be restored from the record page."
        confirmLabel="Delete"
        danger
        loading={bulkWorking}
        onConfirm={() => void bulkDelete()}
      />
    </div>
  )
}
