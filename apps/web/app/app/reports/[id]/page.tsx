"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  RecordHeader,
  Skeleton,
  Tabs,
  emptyFilterTree,
  toast,
  type DataTableColumn,
} from "@yourcrm/ui"
import { ApiError, apiFetch } from "@/lib/api-client"
import { ReportBuilder, draftToBody, emptyDraft, type ReportDraft } from "../report-builder"
import {
  describeReport,
  formatCell,
  type Report,
  type ReportObjectCatalogEntry,
  type ReportResult,
} from "../types"

type ResultRow = Record<string, unknown> & { __id: string }

function toDraft(report: Report): ReportDraft {
  return {
    ...emptyDraft(report.objectType),
    name: report.name,
    description: report.description ?? "",
    visibility: report.visibility,
    filter: report.filter ?? emptyFilterTree(),
    groupBy: report.groupBy ?? "",
    aggregations: report.aggregations ?? [],
    columns: report.columns ?? [],
    sort: report.sort ?? [],
    rowLimit: report.rowLimit,
  }
}

/**
 * Report detail: run view (table output) plus the definition builder.
 * Charts are intentionally absent — dashboards owns visualisation.
 */
export default function ReportDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params.id
  const [report, setReport] = useState<Report | null>(null)
  const [catalogue, setCatalogue] = useState<ReportObjectCatalogEntry[]>([])
  const [draft, setDraft] = useState<ReportDraft>(() => emptyDraft())
  const [result, setResult] = useState<ReportResult | null>(null)
  const [tab, setTab] = useState("results")
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<Report>(`/api/v1/reports/${id}`)
      setReport(data)
      setDraft(toDraft(data))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this report.")
    } finally {
      setLoading(false)
    }
  }, [id])

  const run = useCallback(async () => {
    setRunning(true)
    setRunError(null)
    try {
      setResult(
        await apiFetch<ReportResult>(`/api/v1/reports/${id}/run`, { method: "POST", body: {} }),
      )
    } catch (err) {
      setRunError(err instanceof ApiError ? err.message : "Could not run this report.")
    } finally {
      setRunning(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    apiFetch<ReportObjectCatalogEntry[]>("/api/v1/reports/objects")
      .then(setCatalogue)
      .catch(() => {
        // Labels only; the builder still works with raw field names.
      })
  }, [])

  useEffect(() => {
    if (report !== null) void run()
  }, [report, run])

  const rows = useMemo<ResultRow[]>(
    () => (result?.rows ?? []).map((row, index) => ({ ...row, __id: String(index) })),
    [result],
  )

  const columns = useMemo<DataTableColumn<ResultRow>[]>(
    () =>
      (result?.columns ?? []).map((column) => ({
        id: column.key,
        header: column.label,
        align: column.role === "metric" ? ("right" as const) : ("left" as const),
        accessor: (row: ResultRow) => formatCell(row[column.key]),
      })),
    [result],
  )

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    setSaving(true)
    try {
      const updated = await apiFetch<Report>(`/api/v1/reports/${id}`, {
        method: "PATCH",
        body: draftToBody(draft),
      })
      setReport(updated)
      setDraft(toDraft(updated))
      toast({ title: "Report updated" })
      setTab("results")
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
      await apiFetch(`/api/v1/reports/${id}`, { method: "DELETE" })
      toast({ title: "Report deleted", description: "It can be restored from trash." })
      router.push("/app/reports")
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading report">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (error !== null || report === null) {
    return (
      <ErrorState message={error ?? "This report does not exist."} onRetry={() => void load()} />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/reports" className="text-sm text-muted-foreground hover:underline">
        ← Back to reports
      </Link>
      <RecordHeader
        title={report.name}
        subtitle={describeReport(report, catalogue)}
        status={{
          label: report.visibility,
          tone: report.visibility === "private" ? "secondary" : "success",
        }}
        actions={
          <>
            <Button variant="outline" size="sm" disabled={running} onClick={() => void run()}>
              {running ? "Running…" : "Run"}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </>
        }
      />

      <Tabs
        value={tab}
        onValueChange={setTab}
        ariaLabel="Report sections"
        items={[
          {
            value: "results",
            label: "Results",
            content: (
              <div className="flex flex-col gap-3 py-4">
                {runError !== null ? (
                  <ErrorState message={runError} onRetry={() => void run()} />
                ) : (
                  <>
                    {result !== null ? (
                      <p className="text-xs text-muted-foreground">
                        {result.scope === "own"
                          ? "Showing only records you can access."
                          : "Showing all records in this workspace."}
                        {result.truncated
                          ? ` Truncated to the first ${String(result.limit)} rows.`
                          : ""}
                      </p>
                    ) : null}
                    <DataTable
                      rows={rows}
                      columns={columns}
                      getRowId={(row) => row.__id}
                      ariaLabel={`${report.name} results`}
                      loading={running}
                      empty={
                        <EmptyState
                          title="No matching records"
                          description="Nothing you can access matches this report's filters."
                          action={
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setTab("definition")}
                            >
                              Edit definition
                            </Button>
                          }
                        />
                      }
                    />
                  </>
                )}
              </div>
            ),
          },
          {
            value: "definition",
            label: "Definition",
            content: (
              <form onSubmit={save} className="flex flex-col gap-4 py-4">
                <ReportBuilder
                  catalogue={catalogue}
                  value={draft}
                  onChange={setDraft}
                  lockObjectType
                />
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={() => setDraft(toDraft(report))}>
                    Reset
                  </Button>
                  <Button type="submit" disabled={saving}>
                    {saving ? "Saving…" : "Save changes"}
                  </Button>
                </div>
              </form>
            ),
          },
          {
            value: "about",
            label: "About",
            content: (
              <dl className="grid gap-2 py-4 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Object</dt>
                  <dd>{report.objectType}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Row limit</dt>
                  <dd>{report.rowLimit}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Visibility</dt>
                  <dd>
                    <Badge tone={report.visibility === "private" ? "secondary" : "success"}>
                      {report.visibility}
                    </Badge>
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Last run</dt>
                  <dd>
                    {report.lastRunAt === null
                      ? "Never"
                      : new Date(report.lastRunAt).toLocaleString()}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Created</dt>
                  <dd>{new Date(report.createdAt).toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Updated</dt>
                  <dd>{new Date(report.updatedAt).toLocaleString()}</dd>
                </div>
              </dl>
            ),
          },
        ]}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${report.name}?`}
        description="The report moves to trash and can be restored."
        confirmLabel="Delete"
        danger
        onConfirm={() => void remove()}
      />
    </div>
  )
}
