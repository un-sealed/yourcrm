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
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FilterBuilder,
  SavedViews,
  Select,
  Skeleton,
  TextArea,
  TextField,
  decodeFilterTree,
  emptyFilterTree,
  encodeFilterTree,
  toast,
  type DataTableColumn,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import {
  FORM_FILTER_FIELDS,
  FORM_STATUS_TONES,
  treeToFormsParams,
  type FilterTree,
  type Form,
  type FormsListResponse,
} from "./_components/model"

type SavedViewState = { id: string; name: string; tree: FilterTree; search: string }

const VIEWS_KEY = "yourcrm.forms.views"

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

function formColumns(): DataTableColumn<Form>[] {
  return [
    {
      id: "name",
      header: "Name",
      sortable: true,
      accessor: (row) => (
        <Link href={`/app/forms/${row.id}`} className="font-medium text-primary hover:underline">
          {row.name}
        </Link>
      ),
    },
    {
      id: "status",
      header: "Status",
      accessor: (row) => (
        <Badge tone={FORM_STATUS_TONES[row.status] ?? "secondary"}>{row.status}</Badge>
      ),
    },
    {
      id: "publicId",
      header: "Share token",
      accessor: (row) => (
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{row.publicId}</code>
      ),
    },
    {
      id: "updatedAt",
      header: "Updated",
      sortable: true,
      accessor: (row) => (
        <span className="text-muted-foreground">
          {new Date(row.updatedAt).toLocaleDateString()}
        </span>
      ),
    },
  ]
}

const CREATE_STATUS_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "published", label: "Published" },
]

export default function FormsListPage() {
  const router = useRouter()
  const [rows, setRows] = useState<Form[]>([])
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
  const [createName, setCreateName] = useState("")
  const [createDescription, setCreateDescription] = useState("")
  const [createStatus, setCreateStatus] = useState("draft")
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const params = useMemo(() => {
    const fromTree = treeToFormsParams(tree)
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
      const res = await apiFetchRaw<FormsListResponse>(`/api/v1/forms?${qs.toString()}`)
      setRows(res.data)
      setPagination(res.pagination)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load forms.")
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

  const columns = useMemo(() => formColumns(), [])

  const createForm = async (e: React.FormEvent) => {
    e.preventDefault()
    if (createName.trim() === "") {
      setCreateError("Name is required.")
      return
    }
    setCreateError(null)
    setCreating(true)
    try {
      const form = await apiFetch<Form>("/api/v1/forms", {
        method: "POST",
        body: {
          name: createName.trim(),
          ...(createDescription.trim() === "" ? {} : { description: createDescription.trim() }),
          status: createStatus,
        },
      })
      toast({ title: "Form created", description: `"${form.name}" is ready for fields.` })
      setCreateOpen(false)
      setCreateName("")
      setCreateDescription("")
      setCreateStatus("draft")
      router.push(`/app/forms/${form.id}`)
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create the form.")
      setCreating(false)
    }
  }

  const bulkDelete = async () => {
    setBulkWorking(true)
    try {
      for (const id of selectedIds) {
        await apiFetchRaw(`/api/v1/forms/${id}`, { method: "DELETE" })
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
        <h1 className="text-xl font-semibold">Forms</h1>
        <Button type="button" onClick={() => setCreateOpen(true)}>
          New form
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
          placeholder="Search forms…"
          aria-label="Search forms"
          className="max-w-md"
        />
        <FilterBuilder
          value={tree}
          onChange={(next) => {
            setTree(next)
            setCursor(null)
          }}
          fields={FORM_FILTER_FIELDS}
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
              title="No forms yet"
              description="Create your first lead-capture form, add fields, then publish it to share."
              action={
                <Button type="button" onClick={() => setCreateOpen(true)}>
                  New form
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
        title={`Delete ${selectedIds.length} forms?`}
        description="They move to trash and can be restored from the record page."
        confirmLabel="Delete"
        danger
        loading={bulkWorking}
        onConfirm={() => void bulkDelete()}
      />

      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New form"
        description="Give the form a name. You add fields on the next screen."
      >
        <form onSubmit={createForm} className="flex flex-col gap-4 pt-2">
          <Field label="Name" htmlFor="form-name" required error={createError}>
            <TextField
              id="form-name"
              value={createName}
              onChange={(e) => setCreateName(e.currentTarget.value)}
              placeholder="Contact us"
              required
            />
          </Field>
          <Field label="Description" htmlFor="form-description">
            <TextArea
              id="form-description"
              value={createDescription}
              onChange={(e) => setCreateDescription(e.currentTarget.value)}
              placeholder="What is this form for?"
            />
          </Field>
          <Field label="Status" htmlFor="form-status">
            <Select
              id="form-status"
              value={createStatus}
              onChange={(e) => setCreateStatus(e.currentTarget.value)}
              options={CREATE_STATUS_OPTIONS}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={creating}>
              {creating ? "Creating…" : "Create form"}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  )
}
