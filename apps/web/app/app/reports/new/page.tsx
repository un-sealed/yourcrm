"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button, ErrorState, Skeleton, toast } from "@yourcrm/ui"
import { useUnsavedGuard } from "@/components/use-unsaved-guard"
import { ApiError, apiFetch } from "@/lib/api-client"
import { ReportBuilder, draftToBody, emptyDraft, type ReportDraft } from "../report-builder"
import type { Report, ReportObjectCatalogEntry } from "../types"

/** Create a report: name + object first, everything else progressive. */
export default function NewReportPage() {
  const router = useRouter()
  const [catalogue, setCatalogue] = useState<ReportObjectCatalogEntry[] | null>(null)
  const [draft, setDraft] = useState<ReportDraft>(() => emptyDraft())
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const dirty = draft.name !== "" || draft.objectType !== "" || draft.filter.children.length > 0
  useUnsavedGuard(dirty && !saving)

  const loadCatalogue = () => {
    setLoadError(null)
    apiFetch<ReportObjectCatalogEntry[]>("/api/v1/reports/objects")
      .then(setCatalogue)
      .catch((err: unknown) => {
        setLoadError(err instanceof ApiError ? err.message : "Could not load reportable objects.")
      })
  }

  useEffect(loadCatalogue, [])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (draft.name.trim() === "") {
      setError("A report name is required.")
      return
    }
    if (draft.objectType === "") {
      setError("Choose what this report reads.")
      return
    }
    setError(null)
    setSaving(true)
    try {
      const report = await apiFetch<Report>("/api/v1/reports", {
        method: "POST",
        body: draftToBody(draft),
      })
      toast({ title: "Report created", description: `${draft.name.trim()} is ready to run.` })
      router.push(`/app/reports/${report.id}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the report.")
      setSaving(false)
    }
  }

  if (loadError !== null) {
    return <ErrorState message={loadError} onRetry={loadCatalogue} />
  }

  if (catalogue === null) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading report builder">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">New report</h1>
        <Link href="/app/reports" className="text-sm text-muted-foreground hover:underline">
          Back to reports
        </Link>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <ReportBuilder catalogue={catalogue} value={draft} onChange={setDraft} />
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => router.push("/app/reports")}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Create report"}
          </Button>
        </div>
      </form>
    </div>
  )
}
