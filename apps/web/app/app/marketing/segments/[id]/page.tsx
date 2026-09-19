"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import { Button, ConfirmDialog, ErrorState, RecordHeader, Skeleton, toast } from "@yourcrm/ui"
import { ApiError, apiFetch } from "@/lib/api-client"
import {
  MarketingSegmentBuilder,
  type MarketingSegmentDraft,
  segmentDraftToBody,
} from "../../segment-builder"
import type { MarketingSegment } from "../../types"

function toDraft(segment: MarketingSegment): MarketingSegmentDraft {
  return { name: segment.name, description: segment.description ?? "", filter: segment.filter }
}

/** Segment detail: audience builder (edit in place), live preview, delete. */
export default function MarketingSegmentDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params.id
  const [segment, setSegment] = useState<MarketingSegment | null>(null)
  const [draft, setDraft] = useState<MarketingSegmentDraft | null>(null)
  const [previewCount, setPreviewCount] = useState<number | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<MarketingSegment>(`/api/v1/marketing/segments/${id}`)
      setSegment(data)
      setDraft(toDraft(data))
      setPreviewCount(data.memberCount)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this segment.")
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const preview = async () => {
    setPreviewing(true)
    try {
      const result = await apiFetch<{ count: number }>(`/api/v1/marketing/segments/${id}/preview`, {
        method: "POST",
      })
      setPreviewCount(result.count)
    } catch (err) {
      toast({
        title: "Preview failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setPreviewing(false)
    }
  }

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!draft) return
    setSaving(true)
    try {
      const updated = await apiFetch<MarketingSegment>(`/api/v1/marketing/segments/${id}`, {
        method: "PATCH",
        body: segmentDraftToBody(draft),
      })
      setSegment(updated)
      setDraft(toDraft(updated))
      toast({ title: "Segment updated" })
    } catch (err) {
      toast({
        title: "Update failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    try {
      await apiFetch(`/api/v1/marketing/segments/${id}`, { method: "DELETE" })
      toast({ title: "Segment deleted", description: "It can be restored from trash." })
      router.push("/app/marketing/segments")
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading segment">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (error !== null || segment === null || draft === null) {
    return (
      <ErrorState message={error ?? "This segment does not exist."} onRetry={() => void load()} />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/app/marketing/segments"
        className="text-sm text-muted-foreground hover:underline"
      >
        ← Back to segments
      </Link>
      <RecordHeader
        title={segment.name}
        subtitle={
          segment.lastEvaluatedAt === null
            ? "Never evaluated"
            : `Last evaluated ${new Date(segment.lastEvaluatedAt).toLocaleString()}`
        }
        actions={
          <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        }
      />

      <form onSubmit={save} className="flex flex-col gap-4">
        <MarketingSegmentBuilder
          value={draft}
          onChange={setDraft}
          onPreview={() => void preview()}
          previewCount={previewCount}
          previewing={previewing}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => setDraft(toDraft(segment))}>
            Reset
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${segment.name}?`}
        description="Campaigns already targeting this segment are unaffected; new campaigns cannot pick it."
        confirmLabel="Delete"
        danger
        onConfirm={() => void remove()}
      />
    </div>
  )
}
