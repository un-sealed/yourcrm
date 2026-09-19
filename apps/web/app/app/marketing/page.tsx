"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { Badge, ErrorState, Skeleton, buttonVariants } from "@yourcrm/ui"
import { ApiError, apiFetchRaw } from "@/lib/api-client"
import {
  CAMPAIGN_STATUS_LABEL,
  CAMPAIGN_STATUS_TONE,
  MARKETING_CAMPAIGN_STATUSES,
  type MarketingCampaignsListResponse,
  type MarketingSegmentsListResponse,
} from "./types"

/**
 * Marketing overview: quick counts for segments and campaigns by status,
 * with links into the two workspaces (`/app/marketing/segments`,
 * `/app/marketing/campaigns`). `/app/marketing` is not yet in
 * `nav-sections.ts` (owned by the platform-nav agent) — see the module PR
 * notes for the integrator.
 */
export default function MarketingOverviewPage() {
  const [segments, setSegments] = useState<MarketingSegmentsListResponse | null>(null)
  const [campaigns, setCampaigns] = useState<MarketingCampaignsListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [segmentsRes, campaignsRes] = await Promise.all([
        apiFetchRaw<MarketingSegmentsListResponse>("/api/v1/marketing/segments?limit=1"),
        apiFetchRaw<MarketingCampaignsListResponse>("/api/v1/marketing/campaigns?limit=200"),
      ])
      setSegments(segmentsRes)
      setCampaigns(campaignsRes)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the marketing overview.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (error !== null) {
    return <ErrorState message={error} onRetry={() => void load()} />
  }

  if (loading || segments === null || campaigns === null) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading marketing overview">
        <Skeleton className="h-7 w-48" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      </div>
    )
  }

  const countsByStatus = campaigns.data.reduce<Record<string, number>>((acc, campaign) => {
    acc[campaign.status] = (acc[campaign.status] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Marketing</h1>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <section className="rounded-lg border border-border p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Segments</h2>
            <Link href="/app/marketing/segments" className={buttonVariants({ size: "sm" })}>
              View segments
            </Link>
          </div>
          <p className="mt-2 text-2xl font-semibold">
            {segments.pagination.nextCursor === null
              ? segments.data.length
              : `${segments.data.length}+`}
          </p>
          <p className="text-sm text-muted-foreground">Saved audiences (filters over people)</p>
        </section>

        <section className="rounded-lg border border-border p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Campaigns</h2>
            <Link href="/app/marketing/campaigns" className={buttonVariants({ size: "sm" })}>
              View campaigns
            </Link>
          </div>
          <p className="mt-2 text-2xl font-semibold">{campaigns.data.length}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {MARKETING_CAMPAIGN_STATUSES.map((status) => (
              <Badge key={status} tone={CAMPAIGN_STATUS_TONE[status]}>
                {CAMPAIGN_STATUS_LABEL[status]}: {countsByStatus[status] ?? 0}
              </Badge>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
