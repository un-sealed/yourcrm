"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button, Field, Select, TextArea, TextField, toast } from "@yourcrm/ui"
import { useUnsavedGuard } from "@/components/use-unsaved-guard"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import type { MarketingCampaign, MarketingSegmentsListResponse } from "../../types"

/** Campaign composer: name/subject/body, target segment. Required fields first. */
export default function NewMarketingCampaignPage() {
  const router = useRouter()
  const [segments, setSegments] = useState<{ value: string; label: string }[]>([])
  const [segmentsError, setSegmentsError] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [subject, setSubject] = useState("")
  const [segmentId, setSegmentId] = useState("")
  const [bodyText, setBodyText] = useState("")
  const [bodyHtml, setBodyHtml] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const dirty = name !== "" || subject !== "" || bodyText !== "" || bodyHtml !== ""
  useUnsavedGuard(dirty && !saving)

  useEffect(() => {
    apiFetchRaw<MarketingSegmentsListResponse>("/api/v1/marketing/segments?limit=200")
      .then((res) => setSegments(res.data.map((s) => ({ value: s.id, label: s.name }))))
      .catch((err: unknown) => {
        setSegmentsError(err instanceof ApiError ? err.message : "Could not load segments.")
      })
  }, [])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (name.trim() === "" || subject.trim() === "" || segmentId === "") {
      setError("Name, subject and a target segment are required.")
      return
    }
    if (bodyText.trim() === "" && bodyHtml.trim() === "") {
      setError("A campaign needs a text or HTML body.")
      return
    }
    setError(null)
    setSaving(true)
    try {
      const campaign = await apiFetch<MarketingCampaign>("/api/v1/marketing/campaigns", {
        method: "POST",
        body: {
          name: name.trim(),
          subject: subject.trim(),
          segmentId,
          ...(bodyText.trim() === "" ? {} : { bodyText: bodyText.trim() }),
          ...(bodyHtml.trim() === "" ? {} : { bodyHtml: bodyHtml.trim() }),
        },
      })
      toast({ title: "Campaign created", description: `${name.trim()} is saved as a draft.` })
      router.push(`/app/marketing/campaigns/${campaign.id}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the campaign.")
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">New campaign</h1>
        <Link
          href="/app/marketing/campaigns"
          className="text-sm text-muted-foreground hover:underline"
        >
          Back to campaigns
        </Link>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Campaign name" htmlFor="campaign-name" required>
            <TextField
              id="campaign-name"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="Spring announcement"
              required
            />
          </Field>
          <Field label="Subject line" htmlFor="campaign-subject" required>
            <TextField
              id="campaign-subject"
              value={subject}
              onChange={(event) => setSubject(event.currentTarget.value)}
              placeholder="We have news…"
              required
            />
          </Field>
        </div>

        <Field label="Target segment" htmlFor="campaign-segment" required error={segmentsError}>
          <Select
            id="campaign-segment"
            value={segmentId}
            onChange={(event) => setSegmentId(event.currentTarget.value)}
            options={[{ value: "", label: "Choose a segment…" }, ...segments]}
          />
        </Field>
        {segments.length === 0 && segmentsError === null ? (
          <p className="text-xs text-muted-foreground">
            No segments yet —{" "}
            <Link href="/app/marketing/segments/new" className="underline">
              create one first
            </Link>
            .
          </p>
        ) : null}

        <Field label="Body (plain text)" htmlFor="campaign-body-text">
          <TextArea
            id="campaign-body-text"
            value={bodyText}
            onChange={(event) => setBodyText(event.currentTarget.value)}
            placeholder="Hi {{firstName}}, …"
            rows={6}
          />
        </Field>
        <details className="rounded-md border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">HTML body (advanced)</summary>
          <div className="mt-3">
            <Field label="Body (HTML)" htmlFor="campaign-body-html">
              <TextArea
                id="campaign-body-html"
                value={bodyHtml}
                onChange={(event) => setBodyHtml(event.currentTarget.value)}
                placeholder="<p>Hi {{firstName}}, …</p>"
                rows={6}
              />
            </Field>
          </div>
        </details>

        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push("/app/marketing/campaigns")}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Create draft"}
          </Button>
        </div>
      </form>
    </div>
  )
}
