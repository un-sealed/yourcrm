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
  Field,
  FilterBuilder,
  SavedViews,
  Select,
  Skeleton,
  TextField,
  decodeFilterTree,
  type DataTableColumn,
  emptyFilterTree,
  encodeFilterTree,
  toast,
  type FilterTree,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import {
  DEAL_FILTER_FIELDS,
  DEAL_STAGES,
  formatMoney,
  stageLabel,
  treeToDealsParams,
  weightedValue,
  type Deal,
  type DealsListResponse,
} from "./_components/deals-lib"

type SavedViewState = { id: string; name: string; tree: FilterTree; search: string }

const VIEWS_KEY = "yourcrm.deals.views"

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

function stageTone(stage: string): "success" | "destructive" | "secondary" {
  if (stage === "won") return "success"
  if (stage === "lost") return "destructive"
  return "secondary"
}

function dealColumns(): DataTableColumn<Deal>[] {
  return [
    {
      id: "name",
      header: "Deal",
      sortable: true,
      accessor: (row) => (
        <Link href={`/app/deals/${row.id}`} className="font-medium text-primary hover:underline">
          {row.name}
        </Link>
      ),
    },
    {
      id: "amount",
      header: "Amount",
      sortable: true,
      accessor: (row) => formatMoney(row.amount, row.currency),
    },
    {
      id: "stage",
      header: "Stage",
      accessor: (row) => <Badge tone={stageTone(row.stage)}>{stageLabel(row.stage)}</Badge>,
    },
    {
      id: "probability",
      header: "Probability",
      accessor: (row) =>
        row.probability === null || row.probability === undefined ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          `${row.probability}%`
        ),
    },
    {
      id: "weighted",
      header: "Weighted",
      accessor: (row) => {
        const value = weightedValue(row)
        return value === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          formatMoney(value, row.currency)
        )
      },
    },
    {
      id: "closeDate",
      header: "Close date",
      accessor: (row) => row.expectedCloseDate ?? <span className="text-muted-foreground">—</span>,
    },
  ]
}

export default function DealsListPage() {
  const [rows, setRows] = useState<Deal[]>([])
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
  const [view, setView] = useState<"table" | "board">("table")
  const [sort, setSort] = useState<{ columnId: string; direction: "asc" | "desc" } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [bulkWorking, setBulkWorking] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState("")
  const [newAmount, setNewAmount] = useState("")
  const [newStage, setNewStage] = useState("qualification")
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)

  const params = useMemo(() => {
    const fromTree = treeToDealsParams(tree)
    const query = search.trim() !== "" ? search.trim() : fromTree.query
    return { query, stage: fromTree.stage }
  }, [search, tree])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: "25" })
      if (cursor) qs.set("cursor", cursor)
      if (params.query) qs.set("query", params.query)
      if (params.stage) qs.set("stage", params.stage)
      if (sort && ["name", "amount", "expectedCloseDate", "createdAt"].includes(sort.columnId)) {
        qs.set("sort", sort.columnId)
        qs.set("order", sort.direction)
      }
      const res = await apiFetchRaw<DealsListResponse>(`/api/v1/deals?${qs.toString()}`)
      setRows(res.data)
      setPagination(res.pagination)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load deals.")
    } finally {
      setLoading(false)
    }
  }, [cursor, params.query, params.stage, sort])

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

  const moveStage = useCallback(async (rowId: string, stage: string) => {
    try {
      const updated = await apiFetch<Deal>(`/api/v1/deals/${rowId}/stage`, {
        method: "POST",
        body: { stage },
      })
      setRows((prev) => prev.map((row) => (row.id === rowId ? updated : row)))
      toast({ title: "Deal moved", description: `Now in ${stageLabel(stage)}.` })
    } catch (err) {
      toast({
        title: "Move failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }, [])

  const columns = useMemo(() => dealColumns(), [])

  const grouped = useMemo(() => {
    const map = new Map<string, Deal[]>()
    for (const stage of DEAL_STAGES) map.set(stage, [])
    for (const row of rows) {
      const bucket = map.get(row.stage) ?? []
      bucket.push(row)
      map.set(row.stage, bucket)
    }
    return map
  }, [rows])

  const bulkDelete = async () => {
    setBulkWorking(true)
    try {
      for (const id of selectedIds) {
        await apiFetchRaw(`/api/v1/deals/${id}`, { method: "DELETE" })
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

  const createDeal = async (e: React.FormEvent) => {
    e.preventDefault()
    if (newName.trim() === "") {
      setCreateError("Deal name is required.")
      return
    }
    const parsedAmount = newAmount.trim() === "" ? null : Number(newAmount)
    if (parsedAmount !== null && (!Number.isFinite(parsedAmount) || parsedAmount < 0)) {
      setCreateError("Amount must be zero or more.")
      return
    }
    setCreateError(null)
    setCreating(true)
    try {
      const created = await apiFetch<Deal>("/api/v1/deals", {
        method: "POST",
        body: {
          name: newName.trim(),
          ...(parsedAmount === null ? {} : { amount: parsedAmount }),
          stage: newStage,
        },
      })
      setRows((prev) => [created, ...prev])
      setNewName("")
      setNewAmount("")
      setNewStage("qualification")
      setCreateOpen(false)
      toast({ title: "Deal created", description: `${created.name} was added.` })
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create the deal.")
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Deals</h1>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-border" role="tablist" aria-label="View">
            <Button
              type="button"
              variant={view === "table" ? "default" : "ghost"}
              size="sm"
              role="tab"
              aria-selected={view === "table"}
              onClick={() => setView("table")}
            >
              Table
            </Button>
            <Button
              type="button"
              variant={view === "board" ? "default" : "ghost"}
              size="sm"
              role="tab"
              aria-selected={view === "board"}
              onClick={() => setView("board")}
            >
              Board
            </Button>
          </div>
          <Button type="button" onClick={() => setCreateOpen(true)}>
            New deal
          </Button>
        </div>
      </div>

      <SavedViews
        views={views}
        activeId={activeViewId}
        onSelect={(id) => {
          const found = views.find((v) => v.id === id)
          if (found) {
            setActiveViewId(id)
            setTree(found.tree)
            setSearch(found.search)
            setCursor(null)
          }
        }}
        onCreate={(name) => {
          const saved: SavedViewState = {
            id: crypto.randomUUID(),
            name,
            tree,
            search,
          }
          persistViews([...views, saved])
          setActiveViewId(saved.id)
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
          placeholder="Search deals…"
          aria-label="Search deals"
          className="max-w-md"
        />
        <FilterBuilder
          value={tree}
          onChange={(next) => {
            setTree(next)
            setCursor(null)
          }}
          fields={DEAL_FILTER_FIELDS}
        />
      </div>

      {error !== null ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : view === "table" ? (
        <DataTable
          rows={rows}
          columns={columns}
          getRowId={(row) => row.id}
          selectable
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          loading={loading}
          sort={sort}
          onSortChange={(next) => {
            setSort(next)
            setCursor(null)
          }}
          pagination={{ cursor, ...pagination }}
          onPageChange={(next) => setCursor(next)}
          empty={
            <EmptyState
              title="No deals yet"
              description="Create your first deal to start tracking revenue."
              action={
                <Button type="button" onClick={() => setCreateOpen(true)}>
                  New deal
                </Button>
              }
            />
          }
        />
      ) : loading && rows.length === 0 ? (
        <div className="grid gap-3 md:grid-cols-3" aria-busy="true" aria-label="Loading deals">
          {DEAL_STAGES.slice(0, 3).map((stage) => (
            <div key={stage} className="flex flex-col gap-2 rounded-md border border-border p-3">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No deals yet"
          description="Create your first deal to start tracking revenue."
          action={
            <Button type="button" onClick={() => setCreateOpen(true)}>
              New deal
            </Button>
          }
        />
      ) : (
        <div className="grid items-start gap-3 md:grid-cols-3 xl:grid-cols-6">
          {DEAL_STAGES.map((stage) => (
            <section
              key={stage}
              aria-label={`${stageLabel(stage)} deals`}
              className="flex min-h-32 flex-col gap-2 rounded-md border border-border bg-muted/30 p-2"
              onDragOver={(e) => {
                e.preventDefault()
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragId) {
                  const current = rows.find((row) => row.id === dragId)
                  if (current && current.stage !== stage) void moveStage(dragId, stage)
                  setDragId(null)
                }
              }}
            >
              <h2 className="flex items-center justify-between px-1 text-sm font-semibold">
                {stageLabel(stage)}
                <Badge tone="secondary">{grouped.get(stage)?.length ?? 0}</Badge>
              </h2>
              {(grouped.get(stage) ?? []).map((deal) => (
                <article
                  key={deal.id}
                  draggable
                  onDragStart={() => setDragId(deal.id)}
                  onDragEnd={() => setDragId(null)}
                  className="flex flex-col gap-1 rounded-md border border-border bg-background p-2 shadow-xs"
                >
                  <Link
                    href={`/app/deals/${deal.id}`}
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    {deal.name}
                  </Link>
                  <p className="text-sm text-muted-foreground">
                    {formatMoney(deal.amount, deal.currency)}
                    {deal.probability !== null && deal.probability !== undefined
                      ? ` · ${deal.probability}%`
                      : null}
                  </p>
                  <Select
                    aria-label={`Move ${deal.name} to another stage`}
                    value={deal.stage}
                    onChange={(e) => {
                      if (e.currentTarget.value !== deal.stage) {
                        void moveStage(deal.id, e.currentTarget.value)
                      }
                    }}
                    options={DEAL_STAGES.map((s) => ({ value: s, label: stageLabel(s) }))}
                    className="h-7 text-xs"
                  />
                </article>
              ))}
            </section>
          ))}
        </div>
      )}
      {loading && rows.length === 0 && !error && view === "table" ? (
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
        onOpenChange={setCreateOpen}
        title="New deal"
        description="Deals track revenue from qualification through close."
      >
        <form onSubmit={createDeal} className="mt-4 flex flex-col gap-3">
          <Field label="Deal name" htmlFor="deal-name" required error={createError}>
            <TextField
              id="deal-name"
              value={newName}
              onChange={(e) => setNewName(e.currentTarget.value)}
              placeholder="Acme renewal"
              required
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Amount" htmlFor="deal-amount">
              <TextField
                id="deal-amount"
                type="number"
                min="0"
                step="0.01"
                value={newAmount}
                onChange={(e) => setNewAmount(e.currentTarget.value)}
                placeholder="50000"
              />
            </Field>
            <Field label="Stage" htmlFor="deal-stage">
              <Select
                id="deal-stage"
                value={newStage}
                onChange={(e) => setNewStage(e.currentTarget.value)}
                options={DEAL_STAGES.filter((s) => s !== "won" && s !== "lost").map((s) => ({
                  value: s,
                  label: stageLabel(s),
                }))}
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={creating}>
              {creating ? "Saving…" : "Create deal"}
            </Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={confirmBulkDelete}
        onOpenChange={setConfirmBulkDelete}
        title={`Delete ${selectedIds.length} deals?`}
        description="They move to trash and can be restored from the record page."
        confirmLabel="Delete"
        danger
        loading={bulkWorking}
        onConfirm={() => void bulkDelete()}
      />
    </div>
  )
}
