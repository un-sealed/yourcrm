"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import {
  Button,
  ConfirmDialog,
  ErrorState,
  RecordHeader,
  Skeleton,
  buttonVariants,
  toast,
} from "@yourcrm/ui"
import { useUnsavedGuard } from "@/components/use-unsaved-guard"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import { CustomRecordFields } from "../../../record-fields"
import { formatCustomFieldValue, type CustomObjectRecordDetail } from "../../../types"
import {
  missingRequiredFields,
  toApiValues,
  toFormState,
  type CustomFieldFormValue,
  type CustomObjectFormState,
} from "../../../values"

/**
 * Generic record detail: header, the object's own fields as an editable
 * form, plus any values left behind by fields that were removed — shown
 * read-only so it is visible that deleting a definition hid data rather
 * than destroying it.
 */
export default function CustomObjectRecordPage() {
  const params = useParams<{ slug: string; id: string }>()
  const router = useRouter()
  const { slug, id } = params

  const [detail, setDetail] = useState<CustomObjectRecordDetail | null>(null)
  const [values, setValues] = useState<CustomObjectFormState>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useUnsavedGuard(dirty && !saving)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<CustomObjectRecordDetail>(
        `/api/v1/custom-objects/${slug}/records/${id}`,
      )
      setDetail(data)
      setValues(toFormState(data.fields, data.fieldValues))
      setDirty(false)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this record.")
    } finally {
      setLoading(false)
    }
  }, [slug, id])

  useEffect(() => {
    void load()
  }, [load])

  const change = (key: string, value: CustomFieldFormValue) => {
    setDirty(true)
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!detail) return
    const missing = missingRequiredFields(detail.fields, values)
    if (missing.length > 0) {
      setFormError(`Required: ${missing.join(", ")}.`)
      return
    }
    setFormError(null)
    setSaving(true)
    try {
      await apiFetch(`/api/v1/custom-objects/${slug}/records/${id}`, {
        method: "PATCH",
        body: { values: toApiValues(detail.fields, values) },
      })
      toast({ title: "Saved", description: `${detail.object.name} updated.` })
      await load()
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not save the record.")
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    setDeleting(true)
    try {
      await apiFetchRaw(`/api/v1/custom-objects/${slug}/records/${id}`, { method: "DELETE" })
      toast({ title: "Deleted", description: "The record moved to trash." })
      router.push(`/app/custom-objects/${slug}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete the record.")
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  if (error !== null) return <ErrorState message={error} onRetry={() => void load()} />

  if (loading || detail === null) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading record">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-9 w-full max-w-lg" />
        <Skeleton className="h-9 w-full max-w-lg" />
      </div>
    )
  }

  const liveKeys = new Set(detail.fields.map((field) => field.key))
  const orphaned = Object.entries(detail.fieldValues).filter(([key]) => !liveKeys.has(key))

  return (
    <div className="flex flex-col gap-4">
      <RecordHeader
        title={detail.displayName}
        subtitle={detail.object.name}
        actions={
          <>
            <Link
              href={`/app/custom-objects/${slug}`}
              className={buttonVariants({ variant: "outline" })}
            >
              Back
            </Link>
            <Button type="button" variant="destructive" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </>
        }
      />

      <form onSubmit={save} className="flex max-w-2xl flex-col gap-4">
        <CustomRecordFields
          fields={detail.fields}
          values={values}
          onChange={change}
          disabled={saving}
        />
        {formError !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={!dirty} onClick={() => void load()}>
            Reset
          </Button>
          <Button type="submit" disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>

      {orphaned.length > 0 ? (
        <section className="max-w-2xl rounded-md border border-border p-3">
          <h2 className="text-sm font-medium">Archived fields</h2>
          <p className="mb-2 text-xs text-muted-foreground">
            These values belong to fields that were removed. They are kept and reappear if the field
            is restored.
          </p>
          <dl className="flex flex-col gap-1 text-sm">
            {orphaned.map(([key, value]) => (
              <div key={key} className="flex gap-2">
                <dt className="text-muted-foreground">
                  <code className="text-xs">{key}</code>
                </dt>
                <dd>
                  {formatCustomFieldValue(
                    {
                      id: key,
                      objectType: detail.object.slug,
                      key,
                      label: key,
                      fieldType: "text",
                      options: null,
                      defaultValue: null,
                      required: false,
                      displayOrder: 0,
                    },
                    value,
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${detail.displayName}?`}
        description="It moves to trash and can be restored through the API."
        confirmLabel="Delete"
        danger
        loading={deleting}
        onConfirm={() => void remove()}
      />
    </div>
  )
}
