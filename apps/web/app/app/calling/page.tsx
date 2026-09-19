"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FilterBuilder,
  SavedViews,
  Skeleton,
  TextField,
  buttonVariants,
  decodeFilterTree,
  emptyFilterTree,
  encodeFilterTree,
  toast,
  type DataTableColumn,
  type FilterTree,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import { treeToCallingParams } from "./filters"
import {
  CALL_FILTER_FIELDS,
  CALL_STATUS_LABELS,
  statusTone,
  type CallListResponse,
  type CallRecord,
} from "./types"

type SavedViewState = { id: string; name: string; tree: FilterTree; search: string }

const VIEWS_KEY = "yourcrm.calling.views"

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

function callColumns(): DataTableColumn<CallRecord>[] {
  return [
    {
      id: "direction",
      header: "Direction",
      accessor: (row) => (
        <Link href={`/app/calling/${row.id}`} className="font-medium text-primary hover:underline">
          {row.direction === "inbound" ? "Inbound" : "Outbound"}
        </Link>
      ),
    },
    { id: "from", header: "From", accessor: (row) => row.fromNumber },
    { id: "to", header: "To", accessor: (row) => row.toNumber },
    {
      id: "status",
      header: "Status",
      sortable: true,
      accessor: (row) => (
        <Badge tone={statusTone(row.status)}>{CALL_STATUS_LABELS[row.status]}</Badge>
      ),
    },
    {
      id: "duration",
      header: "Duration",
      accessor: (row) =>
        row.durationSeconds !== null ? (
          `${row.durationSeconds}s`
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "disposition",
      header: "Disposition",
      accessor: (row) => row.disposition ?? <span className="text-muted-foreground">—</span>,
    },
    {
      id: "when",
      header: "Logged",
      sortable: true,
      accessor: (row) => new Date(row.createdAt).toLocaleString(),
    },
  ]
}

/** Click-to-call dialog: a phone number in, a placed call out. */
function ClickToCallDialog({
  open,
  onOpenChange,
  onPlaced,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPlaced: () => void
}) {
  const [toNumber, setToNumber] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (toNumber.trim() === "") {
      setError("Enter a phone number to call.")
      return
    }
    setError(null)
    setWorking(true)
    try {
      await apiFetch("/api/v1/calling/place", {
        method: "POST",
        body: { toNumber: toNumber.trim() },
      })
      toast({ title: "Call placed", description: `Calling ${toNumber.trim()}…` })
      setToNumber("")
      onOpenChange(false)
      onPlaced()
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not place the call. Connect a calling provider or log it manually.",
      )
    } finally {
      setWorking(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Click to call"
      description="Places the call through your workspace's connected calling provider."
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Phone number" htmlFor="click-to-call-number" required error={error}>
          <TextField
            id="click-to-call-number"
            type="tel"
            value={toNumber}
            onChange={(e) => setToNumber(e.currentTarget.value)}
            placeholder="+1 415 555 0123"
            invalid={error !== null}
            autoFocus
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={working}>
            {working ? "Calling…" : "Call"}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

export default function CallingListPage() {
  const [rows, setRows] = useState<CallRecord[]>([])
  const [pagination, setPagination] = useState<{ nextCursor: string | null; limit: number }>({
    nextCursor: null,
    limit: 25,
  })
  const [cursor, setCursor] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [tree, setTree] = useState<FilterTree>(() => emptyFilterTree())
  const [views, setViews] = useState<SavedViewState[]>([])
  const [activeViewId, setActiveViewId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [clickToCallOpen, setClickToCallOpen] = useState(false)

  const params = useMemo(() => {
    const fromTree = treeToCallingParams(tree)
    const query = search.trim() !== "" ? search.trim() : fromTree.query
    return { ...fromTree, query }
  }, [search, tree])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: "25" })
      if (cursor) qs.set("cursor", cursor)
      if (params.direction) qs.set("direction", params.direction)
      if (params.status) qs.set("status", params.status)
      if (params.query) qs.set("query", params.query)
      const res = await apiFetchRaw<CallListResponse>(`/api/v1/calling?${qs.toString()}`)
      setRows(res.data)
      setPagination(res.pagination)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load calls.")
    } finally {
      setLoading(false)
    }
  }, [cursor, params.direction, params.status, params.query])

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

  const columns = useMemo(() => callColumns(), [])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Calling</h1>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => setClickToCallOpen(true)}>
            Click to call
          </Button>
          <Link href="/app/calling/new" className={buttonVariants()}>
            Log a call
          </Link>
        </div>
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
          const view: SavedViewState = { id: crypto.randomUUID(), name, tree, search }
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
          placeholder="Search calls (number, disposition, notes)…"
          aria-label="Search calls"
          className="max-w-md"
        />
        <FilterBuilder
          value={tree}
          onChange={(next) => {
            setTree(next)
            setCursor(null)
          }}
          fields={CALL_FILTER_FIELDS}
        />
      </div>

      {error !== null ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          getRowId={(row) => row.id}
          loading={loading}
          pagination={{ cursor, ...pagination }}
          onPageChange={(next) => setCursor(next)}
          empty={
            <EmptyState
              title="No calls yet"
              description="Place a click-to-call or log a call made outside the system."
              action={
                <div className="flex gap-2">
                  <Button type="button" onClick={() => setClickToCallOpen(true)}>
                    Click to call
                  </Button>
                  <Link href="/app/calling/new" className={buttonVariants({ variant: "outline" })}>
                    Log a call
                  </Link>
                </div>
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

      <ClickToCallDialog
        open={clickToCallOpen}
        onOpenChange={setClickToCallOpen}
        onPlaced={() => void load()}
      />
    </div>
  )
}
