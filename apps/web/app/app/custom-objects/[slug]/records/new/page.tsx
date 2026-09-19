"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import { Button, ErrorState, Skeleton, toast } from "@yourcrm/ui"
import { useUnsavedGuard } from "@/components/use-unsaved-guard"
import { ApiError, apiFetch } from "@/lib/api-client"
import { CustomRecordFields } from "../../../record-fields"
import type { CustomObjectDetail, CustomObjectRecord } from "../../../types"
import {
  emptyFormState,
  missingRequiredFields,
  toApiValues,
  type CustomFieldFormValue,
  type CustomObjectFormState,
} from "../../../values"

/** Create a record of a custom object, with controls built from its fields. */
export default function NewCustomObjectRecordPage() {
  const params = useParams<{ slug: string }>()
  const router = useRouter()
  const slug = params.slug

  const [detail, setDetail] = useState<CustomObjectDetail | null>(null)
  const [values, setValues] = useState<CustomObjectFormState>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useUnsavedGuard(dirty && !saving)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<CustomObjectDetail>(`/api/v1/custom-objects/${slug}`)
      setDetail(data)
      setValues(emptyFormState(data.fields))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this object.")
    } finally {
      setLoading(false)
    }
  }, [slug])

  useEffect(() => {
    void load()
  }, [load])

  const change = (key: string, value: CustomFieldFormValue) => {
    setDirty(true)
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  const submit = async (e: React.FormEvent) => {
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
      const record = await apiFetch<CustomObjectRecord>(`/api/v1/custom-objects/${slug}/records`, {
        method: "POST",
        body: { values: toApiValues(detail.fields, values) },
      })
      setDirty(false)
      toast({ title: `${detail.name} created`, description: record.displayName })
      router.push(`/app/custom-objects/${slug}/records/${record.id}`)
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not create the record.")
      setSaving(false)
    }
  }

  if (error !== null) return <ErrorState message={error} onRetry={() => void load()} />

  if (loading || detail === null) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4" aria-busy="true">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">New {detail.name.toLowerCase()}</h1>
        <Link
          href={`/app/custom-objects/${slug}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          Back to {detail.pluralName.toLowerCase()}
        </Link>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <CustomRecordFields fields={detail.fields} values={values} onChange={change} />
        {formError !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push(`/app/custom-objects/${slug}`)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={saving || detail.fields.length === 0}>
            {saving ? "Saving…" : `Create ${detail.name.toLowerCase()}`}
          </Button>
        </div>
      </form>
    </div>
  )
}
