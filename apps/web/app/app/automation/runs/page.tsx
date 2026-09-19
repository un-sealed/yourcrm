"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  Select,
  buttonVariants,
  type DataTableColumn,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import {
  formatRunTimestamp,
  RUN_STATUS_TONES,
  type WorkflowRun,
  type WorkflowRunDetail,
  type WorkflowRunsListResponse,
} from "../types"

/**
 * Workspace-wide run history (spec 25 route `/app/automation/runs`).
 * Every run records why it ended the way it did — including "the owner
 * could not do this" and "the cascade got too deep".
 */
export default function AutomationRunsPage() {
  const [rows, setRows] = useState<WorkflowRun[]>([])
  const [status, setStatus] = useState("")
  const [selected, setSelected] = useState<WorkflowRunDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: "50" })
      if (status !== "") qs.set("status", status)
      const res = await apiFetchRaw<WorkflowRunsListResponse>(
        `/api/v1/automation/runs?${qs.toString()}`,
      )
      setRows(res.data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load run history.")
    } finally {
      setLoading(false)
    }
  }, [status])

  useEffect(() => {
    void load()
  }, [load])

  const open = useCallback(async (runId: string) => {
    try {
      setSelected(await apiFetch<WorkflowRunDetail>(`/api/v1/automation/runs/${runId}`))
    } catch {
      setSelected(null)
    }
  }, [])

  const columns = useMemo<DataTableColumn<WorkflowRun>[]>(
    () => [
      {
        id: "status",
        header: "Status",
        accessor: (row) => (
          <Badge tone={RUN_STATUS_TONES[row.status] ?? "secondary"}>{row.status}</Badge>
        ),
      },
      { id: "trigger", header: "Trigger", accessor: (row) => row.triggerEvent },
      { id: "record", header: "Record", accessor: (row) => row.entityId ?? "—" },
      { id: "depth", header: "Depth", accessor: (row) => row.depth },
      { id: "started", header: "Started", accessor: (row) => formatRunTimestamp(row.startedAt) },
      {
        id: "workflow",
        header: "Automation",
        accessor: (row) => (
          <Link href={`/app/automation/${row.workflowId}`} className="text-primary hover:underline">
            Open
          </Link>
        ),
      },
      {
        id: "steps",
        header: "",
        accessor: (row) => (
          <Button variant="ghost" size="sm" onClick={() => void open(row.id)}>
            Steps
          </Button>
        ),
      },
    ],
    [open],
  )

  if (error !== null) {
    return <ErrorState message={error} onRetry={() => void load()} />
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Automation runs</h1>
          <p className="text-sm text-muted-foreground">
            One row per triggering event. A redelivered event reuses its run rather than acting
            twice.
          </p>
        </div>
        <Link href="/app/automation" className={buttonVariants({ variant: "outline" })}>
          Automations
        </Link>
      </header>

      <Select
        className="max-w-[14rem]"
        aria-label="Filter by run status"
        value={status}
        onChange={(e) => setStatus(e.target.value)}
        options={[
          { value: "", label: "Any status" },
          { value: "queued", label: "Queued" },
          { value: "running", label: "Running" },
          { value: "succeeded", label: "Succeeded" },
          { value: "failed", label: "Failed" },
          { value: "skipped", label: "Skipped" },
        ]}
      />

      {!loading && rows.length === 0 ? (
        <EmptyState
          title="No runs yet"
          description="Runs appear here as soon as an enabled automation reacts to an event."
        />
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          getRowId={(row) => row.id}
          selectable={false}
          loading={loading}
          ariaLabel="Automation runs"
          empty="No runs match that filter."
        />
      )}

      {selected !== null ? (
        <section className="rounded-md border border-border p-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Steps for run {selected.id}</h2>
            <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
              Close
            </Button>
          </div>
          {selected.error !== null ? (
            <p className="mt-1 text-sm text-destructive">{selected.error}</p>
          ) : null}
          <ol className="mt-2 flex flex-col gap-1">
            {selected.steps.length === 0 ? (
              <li className="text-sm text-muted-foreground">No steps ran.</li>
            ) : (
              selected.steps.map((step) => (
                <li key={step.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone={RUN_STATUS_TONES[step.status] ?? "secondary"}>{step.status}</Badge>
                  <span className="font-medium">
                    {step.stepIndex + 1}. {step.actionType}
                  </span>
                  {step.error !== null ? (
                    <span className="text-destructive">{step.error}</span>
                  ) : null}
                </li>
              ))
            )}
          </ol>
        </section>
      ) : null}
    </div>
  )
}
