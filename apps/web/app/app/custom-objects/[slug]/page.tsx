"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import {
  Badge,
  BulkBar,
  Button,
  Checkbox,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FilterBuilder,
  RecordHeader,
  Select,
  Skeleton,
  Tabs,
  TextField,
  buttonVariants,
  emptyFilterTree,
  type DataTableColumn,
  type FilterTree,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import { treeToCustomObjectParams } from "../filters"
import {
  CUSTOM_OBJECT_FIELD_TYPE_OPTIONS,
  formatCustomFieldValue,
  toFilterFields,
  type CustomObjectDetail,
  type CustomObjectFieldDef,
  type CustomObjectRecord,
  type CustomObjectRecordListResponse,
} from "../types"
import { parseOptionList } from "../values"

/**
 * One custom object: its field definitions and its records.
 *
 * Both tabs are fully generic — the columns and the controls come from the
 * definitions fetched at runtime, never from a hard-coded schema.
 */
export default function CustomObjectPage() {
  const params = useParams<{ slug: string }>()
  const slug = params.slug

  const [detail, setDetail] = useState<CustomObjectDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState("records")

  const loadDetail = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setDetail(await apiFetch<CustomObjectDetail>(`/api/v1/custom-objects/${slug}`))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this object.")
    } finally {
      setLoading(false)
    }
  }, [slug])

  useEffect(() => {
    void loadDetail()
  }, [loadDetail])

  if (error !== null) {
    return <ErrorState message={error} onRetry={() => void loadDetail()} />
  }

  if (loading && detail === null) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading object">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    )
  }

  if (detail === null) return null

  return (
    <div className="flex flex-col gap-4">
      <RecordHeader
        title={detail.pluralName}
        subtitle={detail.description ?? `API slug: ${detail.slug}`}
        actions={
          <>
            <Link href="/app/custom-objects" className={buttonVariants({ variant: "outline" })}>
              All objects
            </Link>
            <Link href={`/app/custom-objects/${slug}/records/new`} className={buttonVariants()}>
              New {detail.name.toLowerCase()}
            </Link>
          </>
        }
      />

      <Tabs
        value={tab}
        onValueChange={setTab}
        ariaLabel={`${detail.name} sections`}
        items={[
          {
            value: "records",
            label: detail.pluralName,
            content: <RecordsTab slug={slug} detail={detail} />,
          },
          {
            value: "fields",
            label: `Fields (${detail.fields.length})`,
            content: <FieldsTab slug={slug} detail={detail} onChanged={() => void loadDetail()} />,
          },
        ]}
      />
    </div>
  )
}

/* ------------------------------- records -------------------------------- */

function RecordsTab({ slug, detail }: { slug: string; detail: CustomObjectDetail }) {
  const [rows, setRows] = useState<CustomObjectRecord[]>([])
  const [pagination, setPagination] = useState<{ nextCursor: string | null; limit: number }>({
    nextCursor: null,
    limit: 25,
  })
  const [cursor, setCursor] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [tree, setTree] = useState<FilterTree>(() => emptyFilterTree())
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [confirmBulk, setConfirmBulk] = useState(false)
  const [bulkWorking, setBulkWorking] = useState(false)

  const filterFields = useMemo(() => toFilterFields(detail.fields), [detail.fields])
  const params = useMemo(() => {
    const fromTree = treeToCustomObjectParams(tree, detail.fields)
    return { ...fromTree, ...(search.trim() === "" ? {} : { query: search.trim() }) }
  }, [tree, search, detail.fields])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: "25" })
      if (cursor) qs.set("cursor", cursor)
      if (params.query) qs.set("query", params.query)
      if (params.field && params.value !== undefined) {
        qs.set("field", params.field)
        qs.set("value", params.value)
      }
      const res = await apiFetchRaw<CustomObjectRecordListResponse>(
        `/api/v1/custom-objects/${slug}/records?${qs.toString()}`,
      )
      setRows(res.data)
      setPagination(res.pagination)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load records.")
    } finally {
      setLoading(false)
    }
  }, [slug, cursor, params.query, params.field, params.value])

  useEffect(() => {
    void load()
  }, [load])

  const columns = useMemo<DataTableColumn<CustomObjectRecord>[]>(() => {
    const nameColumn: DataTableColumn<CustomObjectRecord> = {
      id: "displayName",
      header: "Name",
      accessor: (row) => (
        <Link
          href={`/app/custom-objects/${slug}/records/${row.id}`}
          className="font-medium text-primary hover:underline"
        >
          {row.displayName}
        </Link>
      ),
    }
    // One column per live field definition — the table shape follows the
    // metadata, so adding a field adds a column with no code change.
    const fieldColumns = detail.fields
      .slice(0, 6)
      .map<DataTableColumn<CustomObjectRecord>>((field) => ({
        id: field.key,
        header: field.label,
        accessor: (row) => {
          const rendered = formatCustomFieldValue(field, row.fieldValues[field.key])
          return rendered === "—" ? <span className="text-muted-foreground">—</span> : rendered
        },
      }))
    return [nameColumn, ...fieldColumns]
  }, [detail.fields, slug])

  const bulkDelete = async () => {
    setBulkWorking(true)
    try {
      for (const id of selectedIds) {
        await apiFetchRaw(`/api/v1/custom-objects/${slug}/records/${id}`, { method: "DELETE" })
      }
      setSelectedIds([])
      setConfirmBulk(false)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Bulk delete failed.")
    } finally {
      setBulkWorking(false)
    }
  }

  if (detail.fields.length === 0) {
    return (
      <EmptyState
        title={`${detail.name} has no fields yet`}
        description="Add at least one field before creating records."
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <TextField
        value={search}
        onChange={(e) => {
          setSearch(e.currentTarget.value)
          setCursor(null)
        }}
        placeholder={`Search ${detail.pluralName.toLowerCase()}…`}
        aria-label={`Search ${detail.pluralName}`}
        className="max-w-md"
      />
      <FilterBuilder
        value={tree}
        onChange={(next) => {
          setTree(next)
          setCursor(null)
        }}
        fields={filterFields}
      />

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
          ariaLabel={detail.pluralName}
          pagination={{ cursor, ...pagination }}
          onPageChange={(next) => setCursor(next)}
          empty={
            <EmptyState
              title={`No ${detail.pluralName.toLowerCase()} yet`}
              description="Create the first one to see it here."
              action={
                <Link href={`/app/custom-objects/${slug}/records/new`} className={buttonVariants()}>
                  New {detail.name.toLowerCase()}
                </Link>
              }
            />
          }
        />
      )}

      <BulkBar selectedCount={selectedIds.length} onClear={() => setSelectedIds([])}>
        <Button type="button" variant="destructive" size="sm" onClick={() => setConfirmBulk(true)}>
          Delete
        </Button>
      </BulkBar>

      <ConfirmDialog
        open={confirmBulk}
        onOpenChange={setConfirmBulk}
        title={`Delete ${selectedIds.length} records?`}
        description="They move to trash and can be restored from the record page."
        confirmLabel="Delete"
        danger
        loading={bulkWorking}
        onConfirm={() => void bulkDelete()}
      />
    </div>
  )
}

/* -------------------------------- fields -------------------------------- */

function FieldsTab({
  slug,
  detail,
  onChanged,
}: {
  slug: string
  detail: CustomObjectDetail
  onChanged: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [key, setKey] = useState("")
  const [label, setLabel] = useState("")
  const [fieldType, setFieldType] = useState("text")
  const [options, setOptions] = useState("")
  const [required, setRequired] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<CustomObjectFieldDef | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const needsOptions = fieldType === "select" || fieldType === "multiselect"

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (label.trim() === "") {
      setFormError("Label is required.")
      return
    }
    setFormError(null)
    setSaving(true)
    try {
      await apiFetch(`/api/v1/custom-objects/${slug}/fields`, {
        method: "POST",
        body: {
          key: key.trim() === "" ? label.trim() : key.trim(),
          label: label.trim(),
          fieldType,
          required,
          displayOrder: detail.fields.length,
          ...(needsOptions ? { options: parseOptionList(options) } : {}),
        },
      })
      setAdding(false)
      setKey("")
      setLabel("")
      setFieldType("text")
      setOptions("")
      setRequired(false)
      onChanged()
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not add the field.")
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async () => {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      await apiFetchRaw(`/api/v1/custom-objects/${slug}/fields/${pendingDelete.id}`, {
        method: "DELETE",
      })
      setPendingDelete(null)
      onChanged()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove the field.")
    } finally {
      setDeleting(false)
    }
  }

  const columns = useMemo<DataTableColumn<CustomObjectFieldDef>[]>(
    () => [
      { id: "label", header: "Label", accessor: (row) => row.label },
      {
        id: "key",
        header: "Key",
        accessor: (row) => <code className="text-xs text-muted-foreground">{row.key}</code>,
      },
      { id: "type", header: "Type", accessor: (row) => <Badge>{row.fieldType}</Badge> },
      {
        id: "required",
        header: "Required",
        accessor: (row) => (row.required ? "Yes" : "No"),
      },
      {
        id: "actions",
        header: "",
        align: "right",
        accessor: (row) => (
          <Button type="button" variant="ghost" size="sm" onClick={() => setPendingDelete(row)}>
            Remove
          </Button>
        ),
      },
    ],
    [],
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          A field&apos;s key and type are permanent. Removing a field hides it and keeps the values
          already stored, so it can be brought back.
        </p>
        <Button type="button" onClick={() => setAdding(true)}>
          Add field
        </Button>
      </div>

      {error !== null ? <ErrorState message={error} onRetry={onChanged} /> : null}

      <DataTable
        rows={detail.fields}
        columns={columns}
        getRowId={(row) => row.id}
        ariaLabel={`${detail.name} fields`}
        empty={
          <EmptyState
            title="No fields yet"
            description="Add the first field to start capturing data."
            action={
              <Button type="button" onClick={() => setAdding(true)}>
                Add field
              </Button>
            }
          />
        }
      />

      <Dialog
        open={adding}
        onOpenChange={setAdding}
        title="Add field"
        description="The key and type cannot be changed afterwards — records store their values under this key."
      >
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Label" htmlFor="field-label" required error={formError}>
            <TextField
              id="field-label"
              value={label}
              onChange={(e) => setLabel(e.currentTarget.value)}
              placeholder="Renewal date"
              required
            />
          </Field>
          <Field label="Key" htmlFor="field-key" hint="Defaults to the label in snake_case.">
            <TextField
              id="field-key"
              value={key}
              onChange={(e) => setKey(e.currentTarget.value)}
              placeholder="renewal_date"
            />
          </Field>
          <Field label="Type" htmlFor="field-type" required>
            <Select
              id="field-type"
              value={fieldType}
              onChange={(e) => setFieldType(e.currentTarget.value)}
              options={CUSTOM_OBJECT_FIELD_TYPE_OPTIONS}
            />
          </Field>
          {needsOptions ? (
            <Field
              label="Options"
              htmlFor="field-options"
              required
              hint="Comma separated, e.g. gold, silver, bronze."
            >
              <TextField
                id="field-options"
                value={options}
                onChange={(e) => setOptions(e.currentTarget.value)}
                placeholder="gold, silver"
              />
            </Field>
          ) : null}
          <label htmlFor="field-required" className="flex items-center gap-2 text-sm">
            <Checkbox
              id="field-required"
              checked={required}
              onChange={(e) => setRequired(e.currentTarget.checked)}
            />
            Required
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Adding…" : "Add field"}
            </Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
        title={`Remove ${pendingDelete?.label ?? "field"}?`}
        description="The field is hidden from forms and tables. Values already stored stay on the records."
        confirmLabel="Remove"
        danger
        loading={deleting}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  )
}
