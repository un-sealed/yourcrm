"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button, toast } from "@yourcrm/ui"
import { useUnsavedGuard } from "@/components/use-unsaved-guard"
import { ApiError, apiFetch } from "@/lib/api-client"
import {
  MarketingSegmentBuilder,
  emptySegmentDraft,
  segmentDraftToBody,
  type MarketingSegmentDraft,
} from "../../segment-builder"
import type { MarketingSegment } from "../../types"

/** Create a segment: name first, filter builder with a live preview. */
export default function NewMarketingSegmentPage() {
  const router = useRouter()
  const [draft, setDraft] = useState<MarketingSegmentDraft>(() => emptySegmentDraft())
  const [previewCount, setPreviewCount] = useState<number | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const dirty = draft.name !== "" || draft.filter.children.length > 0
  useUnsavedGuard(dirty && !saving)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (draft.name.trim() === "") {
      setError("A segment name is required.")
      return
    }
    setError(null)
    setSaving(true)
    try {
      const segment = await apiFetch<MarketingSegment>("/api/v1/marketing/segments", {
        method: "POST",
        body: segmentDraftToBody(draft),
      })
      toast({ title: "Segment created", description: `${draft.name.trim()} is ready to target.` })
      router.push(`/app/marketing/segments/${segment.id}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the segment.")
      setSaving(false)
    }
  }

  // Preview requires a saved segment id (the API evaluates a saved
  // definition); before the first save, this is a client-side reminder
  // rather than a live count.
  const preview = () => {
    setPreviewing(true)
    setTimeout(() => {
      setPreviewCount(null)
      setPreviewing(false)
      toast({
        title: "Save to preview",
        description: "Create the segment first, then preview counts from its detail page.",
      })
    }, 0)
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">New segment</h1>
        <Link
          href="/app/marketing/segments"
          className="text-sm text-muted-foreground hover:underline"
        >
          Back to segments
        </Link>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <MarketingSegmentBuilder
          value={draft}
          onChange={setDraft}
          onPreview={preview}
          previewCount={previewCount}
          previewing={previewing}
        />
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push("/app/marketing/segments")}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Create segment"}
          </Button>
        </div>
      </form>
    </div>
  )
}
