"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FilterBuilder,
  Select,
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
import { treeToKbArticleParams } from "./filters"
import {
  KB_ARTICLE_FILTER_FIELDS,
  type KbArticle,
  type KbArticleListResponse,
  type KbCategory,
} from "./types"

const STATUS_TONE: Record<string, "secondary" | "success" | "outline"> = {
  draft: "secondary",
  published: "success",
  archived: "outline",
}

function articleColumns(categories: KbCategory[]): DataTableColumn<KbArticle>[] {
  const categoryName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? "—"
  return [
    {
      id: "title",
      header: "Title",
      sortable: true,
      accessor: (row) => (
        <Link
          href={`/app/knowledge-base/${row.id}`}
          className="font-medium text-primary hover:underline"
        >
          {row.title}
        </Link>
      ),
    },
    {
      id: "category",
      header: "Category",
      accessor: (row) => categoryName(row.categoryId),
    },
    {
      id: "status",
      header: "Status",
      accessor: (row) => <Badge tone={STATUS_TONE[row.status] ?? "secondary"}>{row.status}</Badge>,
    },
    {
      id: "views",
      header: "Views",
      accessor: (row) => row.viewCount,
    },
  ]
}

export default function KnowledgeBaseListPage() {
  const [rows, setRows] = useState<KbArticle[]>([])
  const [categories, setCategories] = useState<KbCategory[]>([])
  const [pagination, setPagination] = useState<{ nextCursor: string | null; limit: number }>({
    nextCursor: null,
    limit: 25,
  })
  const [cursor, setCursor] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [categoryId, setCategoryId] = useState("")
  const [tree, setTree] = useState<FilterTree>(() => emptyFilterTree())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [newCategoryName, setNewCategoryName] = useState("")
  const [creatingCategory, setCreatingCategory] = useState(false)

  const params = useMemo(() => {
    const fromTree = treeToKbArticleParams(tree)
    const query = search.trim() !== "" ? search.trim() : fromTree.query
    return { query, status: fromTree.status }
  }, [search, tree])

  const loadCategories = useCallback(async () => {
    try {
      const data = await apiFetch<KbCategory[]>("/api/v1/knowledge-base/categories")
      setCategories(data)
    } catch {
      // Category filter is best-effort: the article list still works without it.
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: "25" })
      if (cursor) qs.set("cursor", cursor)
      if (params.query) qs.set("query", params.query)
      if (params.status) qs.set("status", params.status)
      if (categoryId) qs.set("categoryId", categoryId)
      const res = await apiFetchRaw<KbArticleListResponse>(
        `/api/v1/knowledge-base/articles?${qs.toString()}`,
      )
      setRows(res.data)
      setPagination(res.pagination)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load articles.")
    } finally {
      setLoading(false)
    }
  }, [cursor, params.query, params.status, categoryId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void loadCategories()
  }, [loadCategories])

  useEffect(() => {
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

  const columns = useMemo(() => articleColumns(categories), [categories])

  const createCategory = async (e: React.FormEvent) => {
    e.preventDefault()
    if (newCategoryName.trim() === "") return
    setCreatingCategory(true)
    try {
      const slug = newCategoryName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
      await apiFetch<KbCategory>("/api/v1/knowledge-base/categories", {
        method: "POST",
        body: { name: newCategoryName.trim(), slug },
      })
      setNewCategoryName("")
      await loadCategories()
      toast({ title: "Category created" })
    } catch (err) {
      toast({
        title: "Could not create category",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setCreatingCategory(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Knowledge Base</h1>
        <Link href="/app/knowledge-base/new" className={buttonVariants()}>
          New article
        </Link>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <TextField
            value={search}
            onChange={(e) => {
              setSearch(e.currentTarget.value)
              setCursor(null)
            }}
            placeholder="Search articles…"
            aria-label="Search articles"
            className="max-w-md"
          />
          <Field label="Category" htmlFor="kb-category-filter" className="w-48">
            <Select
              id="kb-category-filter"
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.currentTarget.value)
                setCursor(null)
              }}
              options={[
                { value: "", label: "All categories" },
                ...categories.map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
          </Field>
          <form onSubmit={createCategory} className="flex items-end gap-2">
            <Field label="New category" htmlFor="kb-new-category">
              <TextField
                id="kb-new-category"
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.currentTarget.value)}
                placeholder="Guides"
                className="w-40"
              />
            </Field>
            <Button type="submit" variant="outline" size="sm" disabled={creatingCategory}>
              Add
            </Button>
          </form>
        </div>
        <FilterBuilder
          value={tree}
          onChange={(next) => {
            setTree(next)
            setCursor(null)
          }}
          fields={KB_ARTICLE_FILTER_FIELDS}
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
              title="No articles yet"
              description="Write your first article to start building the knowledge base."
              action={
                <Link href="/app/knowledge-base/new" className={buttonVariants()}>
                  New article
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
    </div>
  )
}
