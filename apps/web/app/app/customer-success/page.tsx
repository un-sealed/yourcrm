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
  buttonVariants,
  type DataTableColumn,
} from "@yourcrm/ui"
import { ApiError, apiFetchRaw } from "@/lib/api-client"
import {
  CS_LIFECYCLE_OPTIONS,
  formatCurrency,
  formatDate,
  formatScore,
  healthTone,
  lifecycleTone,
  type CsAccount,
  type CsAccountListResponse,
} from "./types"

const LIFECYCLE_FILTER_OPTIONS = [{ value: "", label: "All stages" }, ...CS_LIFECYCLE_OPTIONS]

function accountColumns(): DataTableColumn<CsAccount>[] {
  return [
    {
      id: "company",
      header: "Account",
      accessor: (row) => (
        <Link
          href={`/app/customer-success/${row.id}`}
          className="font-medium text-primary hover:underline"
        >
          {row.companyId}
        </Link>
      ),
    },
    {
      id: "lifecycleStage",
      header: "Lifecycle",
      accessor: (row) => (
        <Badge tone={lifecycleTone(row.lifecycleStage)}>
          {row.lifecycleStage.replace("_", " ")}
        </Badge>
      ),
    },
    {
      id: "health",
      header: "Health",
      accessor: (row) => {
        const latest = row.latestHealthScore
        if (!latest) return <span className="text-muted-foreground">Not computed</span>
        const score = Number(latest.score)
        return <Badge tone={healthTone(score)}>{formatScore(latest.score)}</Badge>
      },
    },
    {
      id: "arr",
      header: "ARR",
      accessor: (row) => formatCurrency(row.arr),
    },
    {
      id: "renewalDate",
      header: "Renewal",
      sortable: true,
      accessor: (row) => formatDate(row.renewalDate),
    },
  ]
}

export default function CustomerSuccessListPage() {
  const [rows, setRows] = useState<CsAccount[]>([])
  const [pagination, setPagination] = useState<{ nextCursor: string | null; limit: number }>({
    nextCursor: null,
    limit: 25,
  })
  const [cursor, setCursor] = useState<string | null>(null)
  const [lifecycleStage, setLifecycleStage] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: "25" })
      if (cursor) qs.set("cursor", cursor)
      if (lifecycleStage) qs.set("lifecycleStage", lifecycleStage)
      const res = await apiFetchRaw<CsAccountListResponse>(
        `/api/v1/customer-success/accounts?${qs.toString()}`,
      )
      setRows(res.data)
      setPagination(res.pagination)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load customer success accounts.")
    } finally {
      setLoading(false)
    }
  }, [cursor, lifecycleStage])

  useEffect(() => {
    void load()
  }, [load])

  const columns = useMemo(() => accountColumns(), [])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Customer Success</h1>
        <Link href="/app/customer-success/new" className={buttonVariants()}>
          New account
        </Link>
      </div>

      <div className="flex flex-col gap-2 sm:max-w-xs">
        <Select
          aria-label="Filter by lifecycle stage"
          value={lifecycleStage}
          onChange={(e) => {
            setLifecycleStage(e.currentTarget.value)
            setCursor(null)
          }}
          options={LIFECYCLE_FILTER_OPTIONS}
        />
      </div>

      {error !== null ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          getRowId={(row) => row.id}
          loading={loading}
          pagination={{ cursor, ...pagination }}
          onPageChange={(next) => setCursor(next)}
          empty={
            <EmptyState
              title="No customer success accounts yet"
              description="Add your first account to start tracking health and renewals."
              action={
                <Link href="/app/customer-success/new" className={buttonVariants()}>
                  New account
                </Link>
              }
            />
          }
        />
      )}
      {loading && rows.length === 0 && !error ? (
        <div className="flex flex-col gap-2" aria-hidden="true">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      ) : null}
    </div>
  )
}
