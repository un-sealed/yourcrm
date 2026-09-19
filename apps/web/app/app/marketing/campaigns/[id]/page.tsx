"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import {
  Badge,
  Button,
  ConfirmDialog,
  DatePicker,
  ErrorState,
  Field,
  RecordHeader,
  Skeleton,
  toast,
} from "@yourcrm/ui"
import { ApiError, apiFetch } from "@/lib/api-client"
import { CAMPAIGN_STATUS_LABEL, CAMPAIGN_STATUS_TONE, type MarketingCampaign } from "../../types"

const EDITABLE_STATUSES = new Set(["draft", "scheduled"])

/**
 * Campaign detail: properties, counts, and the status-driven primary
 * actions (schedule / send / cancel). Sending is deliberately behind a
 * confirmation dialog — it is bulk, external and, once batches start,
 * cannot be undone for people already emailed.
 */
export default function MarketingCampaignDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const [campaign, setCampaign] = useState<MarketingCampaign | null>(null)
  const [scheduledAt, setScheduledAt] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [confirmSend, setConfirmSend] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<MarketingCampaign>(`/api/v1/marketing/campaigns/${id}`)
      setCampaign(data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this campaign.")
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const schedule = async () => {
    if (scheduledAt === "") return
    setWorking(true)
    try {
      const updated = await apiFetch<MarketingCampaign>(
        `/api/v1/marketing/campaigns/${id}/schedule`,
        { method: "POST", body: { scheduledAt: new Date(scheduledAt).toISOString() } },
      )
      setCampaign(updated)
      toast({ title: "Campaign scheduled" })
    } catch (err) {
      toast({
        title: "Schedule failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setWorking(false)
    }
  }

  const send = async () => {
    setWorking(true)
    try {
      const updated = await apiFetch<MarketingCampaign>(`/api/v1/marketing/campaigns/${id}/send`, {
        method: "POST",
      })
      setCampaign(updated)
      setConfirmSend(false)
      toast({
        title: "Campaign sending",
        description: "Consent-filtered recipients are being emailed in the background.",
      })
    } catch (err) {
      toast({
        title: "Send failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setWorking(false)
    }
  }

  const cancel = async () => {
    setWorking(true)
    try {
      const updated = await apiFetch<MarketingCampaign>(
        `/api/v1/marketing/campaigns/${id}/cancel`,
        { method: "POST" },
      )
      setCampaign(updated)
      setConfirmCancel(false)
      toast({ title: "Campaign cancelled" })
    } catch (err) {
      toast({
        title: "Cancel failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setWorking(false)
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading campaign">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (error !== null || campaign === null) {
    return (
      <ErrorState message={error ?? "This campaign does not exist."} onRetry={() => void load()} />
    )
  }

  const editable = EDITABLE_STATUSES.has(campaign.status)

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/app/marketing/campaigns"
        className="text-sm text-muted-foreground hover:underline"
      >
        ← Back to campaigns
      </Link>
      <RecordHeader
        title={campaign.name}
        subtitle={campaign.subject}
        status={{
          label: CAMPAIGN_STATUS_LABEL[campaign.status],
          tone: CAMPAIGN_STATUS_TONE[campaign.status],
        }}
        actions={
          editable ? (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={working}
                onClick={() => setConfirmCancel(true)}
              >
                Cancel
              </Button>
              <Button size="sm" disabled={working} onClick={() => setConfirmSend(true)}>
                Send now
              </Button>
            </>
          ) : null
        }
      />

      <section className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border p-4">
          <p className="text-xs text-muted-foreground">Recipients</p>
          <p className="text-2xl font-semibold">{campaign.recipientCount}</p>
        </div>
        <div className="rounded-lg border border-border p-4">
          <p className="text-xs text-muted-foreground">Sent</p>
          <p className="text-2xl font-semibold">{campaign.sentCount}</p>
        </div>
        <div className="rounded-lg border border-border p-4">
          <p className="text-xs text-muted-foreground">Failed</p>
          <p className="text-2xl font-semibold">{campaign.failedCount}</p>
        </div>
      </section>

      {editable ? (
        <section aria-label="Schedule" className="flex flex-wrap items-end gap-2">
          <Field label="Schedule a send time" htmlFor="campaign-schedule">
            <DatePicker
              id="campaign-schedule"
              value={scheduledAt}
              onChange={(event) => setScheduledAt(event.currentTarget.value)}
            />
          </Field>
          <Button
            type="button"
            variant="outline"
            disabled={working || scheduledAt === ""}
            onClick={() => void schedule()}
          >
            Save schedule
          </Button>
        </section>
      ) : null}

      <section aria-label="Content" className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Content</h2>
        {campaign.bodyText ? (
          <p className="whitespace-pre-wrap rounded-md border border-border p-3 text-sm">
            {campaign.bodyText}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">No plain-text body.</p>
        )}
      </section>

      <section aria-label="Details" className="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <span className="text-muted-foreground">Scheduled for </span>
          <Badge tone="secondary">
            {campaign.scheduledAt === null
              ? "Not scheduled"
              : new Date(campaign.scheduledAt).toLocaleString()}
          </Badge>
        </div>
        <div>
          <span className="text-muted-foreground">Sent at </span>
          <Badge tone="secondary">
            {campaign.sentAt === null ? "Not sent" : new Date(campaign.sentAt).toLocaleString()}
          </Badge>
        </div>
      </section>

      <ConfirmDialog
        open={confirmSend}
        onOpenChange={setConfirmSend}
        title={`Send "${campaign.name}" now?`}
        description="This emails every consenting, subscribed person in the target segment. People who unsubscribed or never opted in are excluded automatically and cannot be re-added by resending."
        confirmLabel="Send"
        danger
        loading={working}
        onConfirm={() => void send()}
      />
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title={`Cancel "${campaign.name}"?`}
        description="The campaign will not be sent. You can duplicate it later by creating a new campaign."
        confirmLabel="Cancel campaign"
        danger
        loading={working}
        onConfirm={() => void cancel()}
      />
    </div>
  )
}
