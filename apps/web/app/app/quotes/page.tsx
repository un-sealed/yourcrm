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
import { treeToQuoteParams } from "./filters"
import { QUOTE_FILTER_FIELDS, statusTone, type Quote, type QuotesListResponse } from "./types"

type SavedViewState = { id: string; name: string; tree: FilterTree; search: string }

const VIEWS_KEY = "yourcrm.quotes.views"

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

function quoteColumns(): DataTableColumn<Quote>[] {
  return [
    {
      id: "number",
      header: "Number",
      sortable: true,
      accessor: (row) => (
        <Link href={`/app/quotes/${row.id}`} className="font-medium text-primary hover:underline">
          {row.number}
        </Link>
      ),
    },
    {
      id: "status",
      header: "Status",
      accessor: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
    },
    {
      id: "currency",
      header: "Currency",
      accessor: (row) => row.currency,
    },
    {
      id: "expiresAt",
      header: "Expires",
      sortable: true,
      accessor: (row) => row.expiresAt ?? <span className="text-muted-foreground">—</span>,
    },
    {
      id: "notes",
      header: "Notes",
      accessor: (row) => (
        <span className="max-w-48 truncate">
          {row.notes ?? <span className="text-muted-foreground">—</span>}
        </span>
      ),
      renderEdit: ({ row, onCommit, onCancel }) => (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const value = new FormData(e.currentTarget).get("notes")
            onCommit({ notes: typeof value === "string" && value !== "" ? value : null })
          }}
          className="flex items-center gap-1"
        >
          <TextField
            name="notes"
            defaultValue={row.notes ?? ""}
            aria-label="Edit notes"
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
  ]
}

export default function QuotesListPage() {
  const [rows, setRows] = useState<Quote[]>([])
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
    const fromTree = treeToQuoteParams(tree)
    const query = search.trim() !== "" ? search.trim() : fromTree.query
    return { query, status: fromTree.status }
  }, [search, tree])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: "25" })
      if (cursor) qs.set("cursor", cursor)
      if (params.query) qs.set("query", params.query)
      if (params.status) qs.set("status", params.status)
      const res = await apiFetchRaw<QuotesListResponse>(`/api/v1/quotes?${qs.toString()}`)
      setRows(res.data)
      setPagination(res.pagination)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load quotes.")
    } finally {
      setLoading(false)
    }
  }, [cursor, params.query, params.status])

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
    async (rowId: string, patch: Partial<Quote>) => {
      try {
        const updated = await apiFetch<Quote>(`/api/v1/quotes/${rowId}`, {
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

  const columns = useMemo(() => quoteColumns(), [])

  const bulkDelete = async () => {
    setBulkWorking(true)
    try {
      for (const id of selectedIds) {
        await apiFetchRaw(`/api/v1/quotes/${id}`, { method: "DELETE" })
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
        <h1 className="text-xl font-semibold">Quotes</h1>
        <Link href="/app/quotes/new" className={buttonVariants()}>
          New quote
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
          placeholder="Search quotes…"
          aria-label="Search quotes"
          className="max-w-md"
        />
        <FilterBuilder
          value={tree}
          onChange={(next) => {
            setTree(next)
            setCursor(null)
          }}
          fields={QUOTE_FILTER_FIELDS}
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
              title="No quotes yet"
              description="Create your first quote to send a proposal to a customer."
              action={
                <Link href="/app/quotes/new" className={buttonVariants()}>
                  New quote
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
        title={`Delete ${selectedIds.length} quotes?`}
        description="They move to trash and can be restored from the record page."
        confirmLabel="Delete"
        danger
        loading={bulkWorking}
        onConfirm={() => void bulkDelete()}
      />
    </div>
  )
}
