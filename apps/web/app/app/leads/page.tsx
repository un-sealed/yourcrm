"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import {
  Badge,
  BulkBar,
  Button,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  FilterBuilder,
  SavedViews,
  Skeleton,
  TextField,
  decodeFilterTree,
  emptyFilterTree,
  encodeFilterTree,
  toast,
  type DataTableColumn,
  type FilterTree,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import { treeToLeadsParams } from "./_components/filters"
import {
  LeadForm,
  emptyFormValues,
  formValuesToBody,
  type LeadFormValues,
} from "./_components/lead-form"
import {
  LEAD_FILTER_FIELDS,
  displayName,
  statusTone,
  type LeadsListResponse,
  type Lead,
} from "./_components/types"

type SavedViewState = { id: string; name: string; tree: FilterTree; search: string }

const VIEWS_KEY = "yourcrm.leads.views"

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

function leadColumns(): DataTableColumn<Lead>[] {
  return [
    {
      id: "name",
      header: "Name",
      sortable: true,
      accessor: (row) => (
        <Link href={`/app/leads/${row.id}`} className="font-medium text-primary hover:underline">
          {displayName(row)}
        </Link>
      ),
    },
    {
      id: "company",
      header: "Company",
      sortable: true,
      accessor: (row) => row.companyName ?? <span className="text-muted-foreground">—</span>,
    },
    {
      id: "status",
      header: "Status",
      accessor: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
    },
    {
      id: "source",
      header: "Source",
      accessor: (row) => row.source ?? <span className="text-muted-foreground">—</span>,
    },
    {
      id: "score",
      header: "Score",
      sortable: true,
      accessor: (row) => <span className="tabular-nums">{row.score}</span>,
    },
  ]
}

export default function LeadsListPage() {
  const [rows, setRows] = useState<Lead[]>([])
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
  const [createOpen, setCreateOpen] = useState(false)
  const [createSaving, setCreateSaving] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const params = useMemo(() => {
    const fromTree = treeToLeadsParams(tree)
    const query = search.trim() !== "" ? search.trim() : fromTree.query
    return { query, status: fromTree.status, source: fromTree.source }
  }, [search, tree])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: "25" })
      if (cursor) qs.set("cursor", cursor)
      if (params.query) qs.set("query", params.query)
      if (params.status) qs.set("status", params.status)
      if (params.source) qs.set("source", params.source)
      const res = await apiFetchRaw<LeadsListResponse>(`/api/v1/leads?${qs.toString()}`)
      setRows(res.data)
      setPagination(res.pagination)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load leads.")
    } finally {
      setLoading(false)
    }
  }, [cursor, params.query, params.status, params.source])

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

  const createLead = async (values: LeadFormValues) => {
    if (values.firstName.trim() === "") {
      setCreateError("First name is required.")
      return
    }
    setCreateError(null)
    setCreateSaving(true)
    try {
      const lead = await apiFetch<Lead>("/api/v1/leads", {
        method: "POST",
        body: formValuesToBody(values),
      })
      setCreateOpen(false)
      toast({ title: "Lead created", description: `${displayName(lead)} was added.` })
      await load()
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create the lead.")
    } finally {
      setCreateSaving(false)
    }
  }

  const columns = useMemo(() => leadColumns(), [])

  const bulkDelete = async () => {
    setBulkWorking(true)
    try {
      for (const id of selectedIds) {
        await apiFetchRaw(`/api/v1/leads/${id}`, { method: "DELETE" })
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
        <h1 className="text-xl font-semibold">Leads</h1>
        <Button type="button" onClick={() => setCreateOpen(true)}>
          New lead
        </Button>
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
          placeholder="Search leads…"
          aria-label="Search leads"
          className="max-w-md"
        />
        <FilterBuilder
          value={tree}
          onChange={(next) => {
            setTree(next)
            setCursor(null)
          }}
          fields={LEAD_FILTER_FIELDS}
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
          pagination={{ cursor, ...pagination }}
          onPageChange={(next) => setCursor(next)}
          empty={
            <EmptyState
              title="No leads yet"
              description="Add your first lead to start building the pipeline."
              action={
                <Button type="button" onClick={() => setCreateOpen(true)}>
                  New lead
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

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open)
          if (!open) setCreateError(null)
        }}
        title="New lead"
        description="Capture a prospect. Required fields first — the rest can wait."
      >
        <LeadForm
          key={createOpen ? "open" : "closed"}
          initial={emptyFormValues()}
          hideStatus
          saving={createSaving}
          fieldError={createError}
          submitLabel="Create lead"
          onSubmit={(values) => void createLead(values)}
          onCancel={() => setCreateOpen(false)}
        />
      </Dialog>

      <ConfirmDialog
        open={confirmBulkDelete}
        onOpenChange={setConfirmBulkDelete}
        title={`Delete ${selectedIds.length} leads?`}
        description="They move to trash and can be restored from the record page."
        confirmLabel="Delete"
        danger
        loading={bulkWorking}
        onConfirm={() => void bulkDelete()}
      />
    </div>
  )
}
