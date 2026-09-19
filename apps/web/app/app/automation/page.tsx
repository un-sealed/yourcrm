"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Select,
  TextField,
  buttonVariants,
  type DataTableColumn,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import {
  describeWorkflow,
  formatRunTimestamp,
  type Workflow,
  type WorkflowCatalogue,
  type WorkflowsListResponse,
} from "./types"

/**
 * Workflow list: search, status filter, enable/disable, bulk delete, plus
 * the loading, empty and error states every page owes the user.
 */
export default function AutomationListPage() {
  const [rows, setRows] = useState<Workflow[]>([])
  const [catalogue, setCatalogue] = useState<WorkflowCatalogue | null>(null)
  const [pagination, setPagination] = useState<{ nextCursor: string | null; limit: number }>({
    nextCursor: null,
    limit: 25,
  })
  const [cursor, setCursor] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("")
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [working, setWorking] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: "25" })
      if (cursor) qs.set("cursor", cursor)
      if (search.trim() !== "") qs.set("query", search.trim())
      if (status !== "") qs.set("status", status)
      const res = await apiFetchRaw<WorkflowsListResponse>(`/api/v1/automation?${qs.toString()}`)
      setRows(res.data)
      setPagination(res.pagination)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load automations.")
    } finally {
      setLoading(false)
    }
  }, [cursor, search, status])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    apiFetch<WorkflowCatalogue>("/api/v1/automation/catalogue")
      .then(setCatalogue)
      .catch(() => {
        // The catalogue only prettifies trigger labels; the list works without it.
      })
  }, [])

  const toggle = useCallback(
    async (workflow: Workflow) => {
      setWorking(true)
      setActionError(null)
      try {
        const verb = workflow.status === "enabled" ? "disable" : "enable"
        await apiFetch<Workflow>(`/api/v1/automation/${workflow.id}/${verb}`, {
          method: "POST",
          body: {},
        })
        await load()
      } catch (err) {
        setActionError(
          err instanceof ApiError
            ? err.code === "FORBIDDEN"
              ? "Enabling an automation needs the automation-admin permission."
              : err.message
            : "Could not change that automation.",
        )
      } finally {
        setWorking(false)
      }
    },
    [load],
  )

  const columns = useMemo<DataTableColumn<Workflow>[]>(
    () => [
      {
        id: "name",
        header: "Automation",
        accessor: (row) => (
          <Link
            href={`/app/automation/${row.id}`}
            className="font-medium text-primary hover:underline"
          >
            {row.name}
          </Link>
        ),
      },
      {
        id: "definition",
        header: "Does",
        accessor: (row) => (
          <span className="text-muted-foreground">
            {describeWorkflow(row, catalogue ?? undefined)}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessor: (row) => (
          <Badge tone={row.status === "enabled" ? "success" : "secondary"}>{row.status}</Badge>
        ),
      },
      {
        id: "lastRun",
        header: "Last run",
        accessor: (row) => formatRunTimestamp(row.lastRunAt),
      },
      {
        id: "toggle",
        header: "",
        accessor: (row) => (
          <Button
            variant="outline"
            size="sm"
            disabled={working}
            onClick={() => void toggle(row)}
            aria-label={`${row.status === "enabled" ? "Disable" : "Enable"} ${row.name}`}
          >
            {row.status === "enabled" ? "Disable" : "Enable"}
          </Button>
        ),
      },
    ],
    [catalogue, toggle, working],
  )

  const removeSelected = async () => {
    setWorking(true)
    setActionError(null)
    try {
      for (const id of selectedIds) {
        await apiFetch(`/api/v1/automation/${id}`, { method: "DELETE" })
      }
      setSelectedIds([])
      setConfirmDelete(false)
      await load()
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not delete those automations.")
    } finally {
      setWorking(false)
    }
  }

  if (error !== null) {
    return <ErrorState message={error} onRetry={() => void load()} />
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Automation</h1>
          <p className="text-sm text-muted-foreground">
            React to what happens in the CRM — without writing code.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/app/automation/runs" className={buttonVariants({ variant: "outline" })}>
            Run history
          </Link>
          <Link href="/app/automation/new" className={buttonVariants()}>
            New automation
          </Link>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <TextField
          className="max-w-xs"
          placeholder="Search automations"
          aria-label="Search automations"
          value={search}
          onChange={(e) => {
            setCursor(null)
            setSearch(e.target.value)
          }}
        />
        <Select
          className="max-w-[12rem]"
          aria-label="Filter by status"
          value={status}
          onChange={(e) => {
            setCursor(null)
            setStatus(e.target.value)
          }}
          options={[
            { value: "", label: "Any status" },
            { value: "enabled", label: "Enabled" },
            { value: "disabled", label: "Disabled" },
          ]}
        />
        {selectedIds.length > 0 ? (
          <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
            Delete {selectedIds.length}
          </Button>
        ) : null}
      </div>

      {actionError !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      {!loading && rows.length === 0 ? (
        <EmptyState
          title="No automations yet"
          description="Start with something small: when a person is created, create a follow-up task."
          action={
            <Link href="/app/automation/new" className={buttonVariants()}>
              New automation
            </Link>
          }
        />
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          getRowId={(row) => row.id}
          loading={loading}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          ariaLabel="Automations"
          empty="No automations match those filters."
        />
      )}

      {pagination.nextCursor !== null ? (
        <div>
          <Button variant="outline" onClick={() => setCursor(pagination.nextCursor)}>
            Load more
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete these automations?"
        description="They stop running immediately. Deleted automations can be restored from the API."
        confirmLabel="Delete"
        danger
        loading={working}
        onConfirm={() => void removeSelected()}
      />
    </div>
  )
}
