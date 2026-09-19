"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import {
  Button,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Skeleton,
  TextArea,
  TextField,
  buttonVariants,
  type DataTableColumn,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import type { CustomObjectListResponse, CustomObjectSummary } from "./types"

/** Mirrors the server-side slug rule so the form can explain it up front. */
const SLUG_RE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
}

function objectColumns(): DataTableColumn<CustomObjectSummary>[] {
  return [
    {
      id: "name",
      header: "Object",
      accessor: (row) => (
        <Link
          href={`/app/custom-objects/${row.slug}`}
          className="font-medium text-primary hover:underline"
        >
          {row.name}
        </Link>
      ),
    },
    { id: "plural", header: "Plural", accessor: (row) => row.pluralName },
    {
      id: "slug",
      header: "API slug",
      accessor: (row) => <code className="text-xs text-muted-foreground">{row.slug}</code>,
    },
    {
      id: "description",
      header: "Description",
      accessor: (row) => row.description ?? <span className="text-muted-foreground">—</span>,
    },
  ]
}

/**
 * Custom objects workspace: the list of user-defined object types and the
 * form that creates one. Admin-only server-side; the UI does not pretend
 * otherwise — a denied create surfaces the API's own message.
 */
export default function CustomObjectsPage() {
  const [rows, setRows] = useState<CustomObjectSummary[]>([])
  const [pagination, setPagination] = useState<{ nextCursor: string | null; limit: number }>({
    nextCursor: null,
    limit: 25,
  })
  const [cursor, setCursor] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [pluralName, setPluralName] = useState("")
  const [slug, setSlug] = useState("")
  const [slugTouched, setSlugTouched] = useState(false)
  const [description, setDescription] = useState("")
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const [pendingDelete, setPendingDelete] = useState<CustomObjectSummary | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: "25" })
      if (cursor) qs.set("cursor", cursor)
      if (search.trim() !== "") qs.set("query", search.trim())
      const res = await apiFetchRaw<CustomObjectListResponse>(
        `/api/v1/custom-objects?${qs.toString()}`,
      )
      setRows(res.data)
      setPagination(res.pagination)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load custom objects.")
    } finally {
      setLoading(false)
    }
  }, [cursor, search])

  useEffect(() => {
    void load()
  }, [load])

  const columns = useMemo(() => objectColumns(), [])
  const effectiveSlug = slugTouched ? slug : slugify(name)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (name.trim() === "") {
      setFormError("Name is required.")
      return
    }
    if (!SLUG_RE.test(effectiveSlug) || effectiveSlug.length < 2) {
      setFormError("API slug must be lowercase letters, digits and single - or _ separators.")
      return
    }
    setFormError(null)
    setSaving(true)
    try {
      await apiFetch<CustomObjectSummary>("/api/v1/custom-objects", {
        method: "POST",
        body: {
          slug: effectiveSlug,
          name: name.trim(),
          ...(pluralName.trim() === "" ? {} : { pluralName: pluralName.trim() }),
          ...(description.trim() === "" ? {} : { description: description.trim() }),
        },
      })
      setCreating(false)
      setName("")
      setPluralName("")
      setSlug("")
      setSlugTouched(false)
      setDescription("")
      await load()
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not create the object.")
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async () => {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      await apiFetchRaw(`/api/v1/custom-objects/${pendingDelete.slug}`, { method: "DELETE" })
      setPendingDelete(null)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete the object.")
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Custom objects</h1>
          <p className="text-sm text-muted-foreground">
            Define your own object types and fields. No migration, no deploy.
          </p>
        </div>
        <Button type="button" onClick={() => setCreating(true)}>
          New object
        </Button>
      </div>

      <TextField
        value={search}
        onChange={(e) => {
          setSearch(e.currentTarget.value)
          setCursor(null)
        }}
        placeholder="Search objects…"
        aria-label="Search custom objects"
        className="max-w-md"
      />

      {error !== null ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          getRowId={(row) => row.id}
          loading={loading}
          ariaLabel="Custom objects"
          pagination={{ cursor, ...pagination }}
          onPageChange={(next) => setCursor(next)}
          empty={
            <EmptyState
              title="No custom objects yet"
              description="Create one to model something the built-in objects do not cover."
              action={
                <Button type="button" onClick={() => setCreating(true)}>
                  New object
                </Button>
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

      {rows.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {rows.map((row) => (
            <div key={row.id} className="flex items-center gap-2 rounded-md border px-3 py-2">
              <Link
                href={`/app/custom-objects/${row.slug}`}
                className={buttonVariants({ variant: "ghost", size: "sm" })}
              >
                Manage {row.pluralName}
              </Link>
              <Button type="button" variant="ghost" size="sm" onClick={() => setPendingDelete(row)}>
                Delete
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="New custom object"
        description="The API slug is permanent: it identifies the object in URLs and in its field definitions."
      >
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Name" htmlFor="object-name" required error={formError}>
            <TextField
              id="object-name"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="Deal room"
              required
            />
          </Field>
          <Field label="Plural name" htmlFor="object-plural" hint="Defaults to the name plus “s”.">
            <TextField
              id="object-plural"
              value={pluralName}
              onChange={(e) => setPluralName(e.currentTarget.value)}
              placeholder="Deal rooms"
            />
          </Field>
          <Field
            label="API slug"
            htmlFor="object-slug"
            hint="Lowercase letters, digits and single - or _ separators. Cannot be changed later."
          >
            <TextField
              id="object-slug"
              value={effectiveSlug}
              onChange={(e) => {
                setSlugTouched(true)
                setSlug(e.currentTarget.value)
              }}
              placeholder="deal-room"
            />
          </Field>
          <Field label="Description" htmlFor="object-description">
            <TextArea
              id="object-description"
              value={description}
              onChange={(e) => setDescription(e.currentTarget.value)}
              placeholder="What this object is for."
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Creating…" : "Create object"}
            </Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
        title={`Delete ${pendingDelete?.name ?? "object"}?`}
        description="Its fields and records are kept and come back if the object is restored."
        confirmLabel="Delete"
        danger
        loading={deleting}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  )
}
