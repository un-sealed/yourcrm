"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import {
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  Select,
  Skeleton,
  TextField,
  buttonVariants,
  type DataTableColumn,
} from "@yourcrm/ui"
import { ApiError, apiFetchRaw } from "@/lib/api-client"
import {
  CAMPAIGN_STATUS_LABEL,
  CAMPAIGN_STATUS_TONE,
  MARKETING_CAMPAIGN_STATUSES,
  type MarketingCampaign,
  type MarketingCampaignsListResponse,
} from "../types"

/** Campaign list: search, status filter, empty/error states. */
export default function MarketingCampaignsListPage() {
  const [rows, setRows] = useState<MarketingCampaign[]>([])
  const [pagination, setPagination] = useState<{ nextCursor: string | null; limit: number }>({
    nextCursor: null,
    limit: 25,
  })
  const [cursor, setCursor] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: "25" })
      if (cursor) qs.set("cursor", cursor)
      if (search.trim() !== "") qs.set("query", search.trim())
      if (status !== "") qs.set("status", status)
      const res = await apiFetchRaw<MarketingCampaignsListResponse>(
        `/api/v1/marketing/campaigns?${qs.toString()}`,
      )
      setRows(res.data)
      setPagination(res.pagination)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load campaigns.")
    } finally {
      setLoading(false)
    }
  }, [cursor, search, status])

  useEffect(() => {
    void load()
  }, [load])

  const columns = useMemo<DataTableColumn<MarketingCampaign>[]>(
    () => [
      {
        id: "name",
        header: "Campaign",
        sortable: true,
        accessor: (row) => (
          <Link
            href={`/app/marketing/campaigns/${row.id}`}
            className="font-medium text-primary hover:underline"
          >
            {row.name}
          </Link>
        ),
      },
      { id: "subject", header: "Subject", accessor: (row) => row.subject },
      {
        id: "status",
        header: "Status",
        accessor: (row) => (
          <Badge tone={CAMPAIGN_STATUS_TONE[row.status]}>{CAMPAIGN_STATUS_LABEL[row.status]}</Badge>
        ),
      },
      {
        id: "recipients",
        header: "Sent / Recipients",
        align: "right",
        accessor: (row) => `${row.sentCount} / ${row.recipientCount}`,
      },
    ],
    [],
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Campaigns</h1>
        <Link href="/app/marketing/campaigns/new" className={buttonVariants()}>
          New campaign
        </Link>
      </div>

      <div className="flex flex-wrap gap-2">
        <TextField
          value={search}
          onChange={(event) => {
            setSearch(event.currentTarget.value)
            setCursor(null)
          }}
          placeholder="Search campaigns…"
          aria-label="Search campaigns"
          className="max-w-md"
        />
        <Select
          aria-label="Filter by status"
          className="w-48"
          value={status}
          onChange={(event) => {
            setStatus(event.currentTarget.value)
            setCursor(null)
          }}
          options={[
            { value: "", label: "All statuses" },
            ...MARKETING_CAMPAIGN_STATUSES.map((value) => ({
              value,
              label: CAMPAIGN_STATUS_LABEL[value],
            })),
          ]}
        />
      </div>

      {error !== null ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          getRowId={(row) => row.id}
          ariaLabel="Campaigns"
          loading={loading}
          pagination={{ cursor, ...pagination }}
          onPageChange={(next) => setCursor(next)}
          empty={
            <EmptyState
              title="No campaigns yet"
              description="Create a campaign, pick a segment to target, and send when ready."
              action={
                <Link href="/app/marketing/campaigns/new" className={buttonVariants()}>
                  New campaign
                </Link>
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
    </div>
  )
}
