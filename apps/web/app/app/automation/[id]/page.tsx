"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  ErrorState,
  Skeleton,
  buttonVariants,
  type DataTableColumn,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import {
  formatRunTimestamp,
  RUN_STATUS_TONES,
  type Workflow,
  type WorkflowCatalogue,
  type WorkflowRun,
  type WorkflowRunsListResponse,
} from "../types"
import {
  isWorkflowDraftValid,
  toWorkflowPayload,
  WorkflowEditor,
  type WorkflowDraft,
} from "../workflow-editor"

const RUN_COLUMNS: DataTableColumn<WorkflowRun>[] = [
  {
    id: "status",
    header: "Status",
    accessor: (row) => (
      <Badge tone={RUN_STATUS_TONES[row.status] ?? "secondary"}>{row.status}</Badge>
    ),
  },
  { id: "started", header: "Started", accessor: (row) => formatRunTimestamp(row.startedAt) },
  { id: "record", header: "Record", accessor: (row) => row.entityId ?? "—" },
  { id: "depth", header: "Cascade depth", accessor: (row) => row.depth },
  {
    id: "error",
    header: "Detail",
    accessor: (row) => <span className="text-muted-foreground">{row.error ?? "—"}</span>,
  },
]

/** Automation detail: edit the definition, enable/disable, test, see runs. */
export default function AutomationDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const router = useRouter()
  const [workflow, setWorkflow] = useState<Workflow | null>(null)
  const [draft, setDraft] = useState<WorkflowDraft | null>(null)
  const [catalogue, setCatalogue] = useState<WorkflowCatalogue | null>(null)
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const found = await apiFetch<Workflow>(`/api/v1/automation/${id}`)
      setWorkflow(found)
      setDraft({
        name: found.name,
        description: found.description ?? "",
        triggerEvent: found.triggerEvent,
        conditions: found.conditions,
        actions: found.actions ?? [],
      })
      const history = await apiFetchRaw<WorkflowRunsListResponse>(`/api/v1/automation/${id}/runs`)
      setRuns(history.data)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.code === "NOT_FOUND"
            ? "That automation no longer exists."
            : err.message
          : "Could not load that automation.",
      )
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    apiFetch<WorkflowCatalogue>("/api/v1/automation/catalogue")
      .then(setCatalogue)
      .catch(() => {
        // Labels only; the editor still works with raw event names.
      })
  }, [])

  const call = async (run: () => Promise<void>, forbidden: string) => {
    setWorking(true)
    setActionError(null)
    setNotice(null)
    try {
      await run()
    } catch (err) {
      setActionError(
        err instanceof ApiError
          ? err.code === "FORBIDDEN"
            ? forbidden
            : err.message
          : "That did not work.",
      )
    } finally {
      setWorking(false)
    }
  }

  const save = () =>
    call(async () => {
      if (draft === null) return
      await apiFetch<Workflow>(`/api/v1/automation/${id}`, {
        method: "PATCH",
        body: toWorkflowPayload(draft),
      })
      setNotice("Saved.")
      await load()
    }, "You do not have permission to edit automations.")

  const toggle = () =>
    call(async () => {
      const verb = workflow?.status === "enabled" ? "disable" : "enable"
      await apiFetch<Workflow>(`/api/v1/automation/${id}/${verb}`, { method: "POST", body: {} })
      await load()
    }, "Enabling an automation needs the automation-admin permission.")

  const testRun = () =>
    call(async () => {
      await apiFetch(`/api/v1/automation/${id}/run`, { method: "POST", body: {} })
      setNotice("Test run queued — it appears in the run history below.")
      await load()
    }, "Running an automation needs the automation-admin permission.")

  const remove = () =>
    call(async () => {
      await apiFetch(`/api/v1/automation/${id}`, { method: "DELETE" })
      router.push("/app/automation")
    }, "You do not have permission to delete automations.")

  if (error !== null) {
    return <ErrorState message={error} onRetry={() => void load()} />
  }

  if (loading || workflow === null || draft === null) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading automation">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-9 w-full max-w-md" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{workflow.name}</h1>
            <Badge tone={workflow.status === "enabled" ? "success" : "secondary"}>
              {workflow.status}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Runs as its owner. Last run {formatRunTimestamp(workflow.lastRunAt)}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/app/automation" className={buttonVariants({ variant: "ghost" })}>
            Back
          </Link>
          <Button variant="outline" disabled={working} onClick={() => void testRun()}>
            Test run
          </Button>
          <Button variant="outline" disabled={working} onClick={() => void toggle()}>
            {workflow.status === "enabled" ? "Disable" : "Enable"}
          </Button>
          <Button variant="destructive" disabled={working} onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        </div>
      </header>

      {actionError !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}
      {notice !== null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}

      <div className="max-w-3xl">
        <WorkflowEditor
          draft={draft}
          catalogue={catalogue}
          disabled={working}
          onChange={setDraft}
        />
        <div className="mt-4">
          <Button disabled={working || !isWorkflowDraftValid(draft)} onClick={() => void save()}>
            {working ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Recent runs
        </h2>
        <DataTable
          rows={runs}
          columns={RUN_COLUMNS}
          getRowId={(row) => row.id}
          selectable={false}
          ariaLabel="Recent runs"
          empty="This automation has not run yet."
        />
      </section>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this automation?"
        description="It stops running immediately."
        confirmLabel="Delete"
        danger
        loading={working}
        onConfirm={() => void remove()}
      />
    </div>
  )
}
