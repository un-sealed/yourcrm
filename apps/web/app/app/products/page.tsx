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
  Skeleton,
  TextArea,
  TextField,
  decodeFilterTree,
  emptyFilterTree,
  encodeFilterTree,
  type DataTableColumn,
  type FilterTree,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import { PRODUCT_FILTER_FIELDS, type Product, type ProductListResponse } from "./_components/types"
import { treeToProductsParams } from "./_components/filters"

type SavedViewState = { id: string; name: string; tree: FilterTree; search: string }

const VIEWS_KEY = "yourcrm.products.views"

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

function productColumns(): DataTableColumn<Product>[] {
  return [
    {
      id: "sku",
      header: "SKU",
      sortable: true,
      accessor: (row) => (
        <Link href={`/app/products/${row.id}`} className="font-medium text-primary hover:underline">
          {row.sku}
        </Link>
      ),
    },
    {
      id: "name",
      header: "Name",
      sortable: true,
      accessor: (row) => (
        <Link href={`/app/products/${row.id}`} className="hover:underline">
          {row.name}
        </Link>
      ),
    },
    {
      id: "status",
      header: "Status",
      accessor: (row) => (
        <Badge tone={row.isActive ? "success" : "secondary"}>
          {row.isActive ? "Active" : "Inactive"}
        </Badge>
      ),
    },
  ]
}

export default function ProductsListPage() {
  const [rows, setRows] = useState<Product[]>([])
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
  const [createSku, setCreateSku] = useState("")
  const [createName, setCreateName] = useState("")
  const [createDescription, setCreateDescription] = useState("")
  const [createError, setCreateError] = useState<string | null>(null)
  const [createSaving, setCreateSaving] = useState(false)

  const params = useMemo(() => {
    const fromTree = treeToProductsParams(tree)
    const query = search.trim() !== "" ? search.trim() : fromTree.query
    return { query, active: fromTree.active }
  }, [search, tree])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: "25" })
      if (cursor) qs.set("cursor", cursor)
      if (params.query) qs.set("query", params.query)
      if (params.active) qs.set("active", params.active)
      const res = await apiFetchRaw<ProductListResponse>(`/api/v1/products?${qs.toString()}`)
      setRows(res.data)
      setPagination(res.pagination)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load products.")
    } finally {
      setLoading(false)
    }
  }, [cursor, params.query, params.active])

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

  const columns = useMemo(() => productColumns(), [])

  const createProduct = async (e: React.FormEvent) => {
    e.preventDefault()
    if (createSku.trim() === "" || createName.trim() === "") {
      setCreateError("SKU and name are required.")
      return
    }
    setCreateError(null)
    setCreateSaving(true)
    try {
      await apiFetch<Product>("/api/v1/products", {
        method: "POST",
        body: {
          sku: createSku.trim(),
          name: createName.trim(),
          ...(createDescription.trim() === "" ? {} : { description: createDescription.trim() }),
        },
      })
      setCreateOpen(false)
      setCreateSku("")
      setCreateName("")
      setCreateDescription("")
      await load()
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create the product.")
    } finally {
      setCreateSaving(false)
    }
  }

  const bulkDelete = async () => {
    setBulkWorking(true)
    try {
      for (const id of selectedIds) {
        await apiFetchRaw(`/api/v1/products/${id}`, { method: "DELETE" })
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
        <h1 className="text-xl font-semibold">Products</h1>
        <Button type="button" onClick={() => setCreateOpen(true)}>
          New product
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
          placeholder="Search products…"
          aria-label="Search products"
          className="max-w-md"
        />
        <FilterBuilder
          value={tree}
          onChange={(next) => {
            setTree(next)
            setCursor(null)
          }}
          fields={PRODUCT_FILTER_FIELDS}
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
              title="No products yet"
              description="Add your first product to start building the catalog."
              action={
                <Button type="button" onClick={() => setCreateOpen(true)}>
                  New product
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
        title={`Delete ${selectedIds.length} products?`}
        description="They move to trash and can be restored from the record page."
        confirmLabel="Delete"
        danger
        loading={bulkWorking}
        onConfirm={() => void bulkDelete()}
      />

      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New product"
        description="Add a product to the catalog. Prices can be added from the record page."
      >
        <form onSubmit={createProduct} className="flex flex-col gap-4 pt-2">
          <Field label="SKU" htmlFor="product-sku" required error={createError}>
            <TextField
              id="product-sku"
              value={createSku}
              onChange={(e) => setCreateSku(e.currentTarget.value)}
              placeholder="SKU-001"
              required
            />
          </Field>
          <Field label="Name" htmlFor="product-name" required>
            <TextField
              id="product-name"
              value={createName}
              onChange={(e) => setCreateName(e.currentTarget.value)}
              placeholder="Widget"
              required
            />
          </Field>
          <Field label="Description" htmlFor="product-description">
            <TextArea
              id="product-description"
              value={createDescription}
              onChange={(e) => setCreateDescription(e.currentTarget.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={createSaving}>
              {createSaving ? "Creating…" : "Create product"}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  )
}
