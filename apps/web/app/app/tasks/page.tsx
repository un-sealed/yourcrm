"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import {
  Badge,
  BulkBar,
  Button,
  Checkbox,
  ConfirmDialog,
  DataTable,
  DatePicker,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FilterBuilder,
  SavedViews,
  Select,
  Skeleton,
  TextArea,
  TextField,
  decodeFilterTree,
  emptyFilterTree,
  encodeFilterTree,
  toast,
  type DataTableColumn,
  type FilterTree,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import {
  TASK_FILTER_FIELDS,
  formatDueDate,
  isOverdue,
  treeToTasksParams,
  type Task,
  type TasksListResponse,
} from "./_components/task-helpers"

type SavedViewState = { id: string; name: string; tree: FilterTree; search: string }

const VIEWS_KEY = "yourcrm.tasks.views"

const PRIORITY_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
]

const PRIORITY_TONES = {
  low: "secondary",
  medium: "secondary",
  high: "warning",
  urgent: "destructive",
} as const

function readViews(): SavedViewState[] {
  try {
    const raw = window.localStorage.getItem(VIEWS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (v): v is SavedViewState =>
        typeof v === "object" && v !== null && typeof (v as { id: string }).id === "string",
    )
  } catch {
    return []
  }
}

export default function TasksListPage() {
  const [rows, setRows] = useState<Task[]>([])
  const [pagination, setPagination] = useState<{ nextCursor: string | null; limit: number }>({
    nextCursor: null,
    limit: 25,
  })
  const [cursor, setCursor] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [tree, setTree] = useState<FilterTree>(() => emptyFilterTree())
  const [views, setViews] = useState<SavedViewState[]>([])
  const [activeViewId, setActiveViewId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [mineOnly, setMineOnly] = useState(true)
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [bulkWorking, setBulkWorking] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createTitle, setCreateTitle] = useState("")
  const [createDescription, setCreateDescription] = useState("")
  const [createPriority, setCreatePriority] = useState("medium")
  const [createDue, setCreateDue] = useState("")
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const params = useMemo(() => {
    const fromTree = treeToTasksParams(tree)
    const query = search.trim() !== "" ? search.trim() : fromTree.query
    return { query, status: fromTree.status, priority: fromTree.priority }
  }, [search, tree])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: "25" })
      if (cursor) qs.set("cursor", cursor)
      if (params.query) qs.set("query", params.query)
      if (params.status) qs.set("status", params.status)
      if (params.priority) qs.set("priority", params.priority)
      if (mineOnly) qs.set("mine", "true")
      if (overdueOnly) qs.set("overdue", "true")
      const res = await apiFetchRaw<TasksListResponse>(`/api/v1/tasks?${qs.toString()}`)
      setRows(res.data)
      setPagination(res.pagination)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load tasks.")
    } finally {
      setLoading(false)
    }
  }, [cursor, mineOnly, overdueOnly, params.priority, params.query, params.status])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setViews(readViews())
    try {
      const url = new URL(window.location.href)
      const encoded = url.searchParams.get("filter")
      if (encoded) setTree(decodeFilterTree(encoded))
      const q = url.searchParams.get("q")
      if (q) setSearch(q)
    } catch {
      // Shareable URLs are best-effort; the list works without them.
    }
  }, [])

  useEffect(() => {
    try {
      const url = new URL(window.location.href)
      url.searchParams.set("filter", encodeFilterTree(tree))
      if (search.trim() !== "") url.searchParams.set("q", search.trim())
      else url.searchParams.delete("q")
      window.history.replaceState(null, "", url.toString())
    } catch {
      // Non-browser render: skip URL persistence.
    }
  }, [tree, search])

  const persistViews = (next: SavedViewState[]) => {
    setViews(next)
    try {
      window.localStorage.setItem(VIEWS_KEY, JSON.stringify(next))
    } catch {
      // Private mode etc: views stay in memory for the session.
    }
  }

  const toggleComplete = useCallback(async (row: Task) => {
    try {
      const action = row.status === "completed" ? "reopen" : "complete"
      const updated = await apiFetch<Task>(`/api/v1/tasks/${row.id}/${action}`, {
        method: "POST",
      })
      setRows((prev) => prev.map((r) => (r.id === row.id ? updated : r)))
    } catch (err) {
      toast({
        title: "Could not update the task",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }, [])

  const columns = useMemo<DataTableColumn<Task>[]>(
    () => [
      {
        id: "done",
        header: "Done",
        accessor: (row) => (
          <Checkbox
            checked={row.status === "completed"}
            onChange={() => void toggleComplete(row)}
            aria-label={
              row.status === "completed" ? `Reopen ${row.title}` : `Complete ${row.title}`
            }
          />
        ),
      },
      {
        id: "title",
        header: "Title",
        sortable: true,
        accessor: (row) => (
          <Link href={`/app/tasks/${row.id}`} className="font-medium text-primary hover:underline">
            {row.title}
          </Link>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessor: (row) => {
          const overdue = isOverdue(row)
          return (
            <span className="flex items-center gap-1">
              <Badge tone={row.status === "completed" ? "success" : "secondary"}>
                {row.status.replace("_", " ")}
              </Badge>
              {overdue ? <Badge tone="destructive">Overdue</Badge> : null}
            </span>
          )
        },
      },
      {
        id: "priority",
        header: "Priority",
        sortable: true,
        accessor: (row) => (
          <Badge tone={PRIORITY_TONES[row.priority as keyof typeof PRIORITY_TONES] ?? "secondary"}>
            {row.priority}
          </Badge>
        ),
      },
      {
        id: "due",
        header: "Due",
        sortable: true,
        accessor: (row) => {
          const overdue = isOverdue(row)
          return (
            <span className={overdue ? "font-medium text-destructive" : undefined}>
              {formatDueDate(row.dueDate)}
            </span>
          )
        },
      },
    ],
    [toggleComplete],
  )

  const bulkDelete = async () => {
    setBulkWorking(true)
    try {
      for (const id of selectedIds) {
        await apiFetchRaw(`/api/v1/tasks/${id}`, { method: "DELETE" })
      }
      setSelectedIds([])
      setConfirmBulkDelete(false)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Bulk delete failed.")
    } finally {
      setBulkWorking(false)
    }
  }

  const createTask = async (e: React.FormEvent) => {
    e.preventDefault()
    if (createTitle.trim() === "") {
      setCreateError("Title is required.")
      return
    }
    setCreateError(null)
    setCreating(true)
    try {
      await apiFetch<Task>("/api/v1/tasks", {
        method: "POST",
        body: {
          title: createTitle.trim(),
          ...(createDescription.trim() === "" ? {} : { description: createDescription.trim() }),
          priority: createPriority,
          ...(createDue === "" ? {} : { dueDate: new Date(createDue).toISOString() }),
        },
      })
      setCreateOpen(false)
      setCreateTitle("")
      setCreateDescription("")
      setCreatePriority("medium")
      setCreateDue("")
      toast({ title: "Task created" })
      await load()
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create the task.")
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Tasks</h1>
        <Button type="button" onClick={() => setCreateOpen(true)}>
          New task
        </Button>
      </div>

      <SavedViews
        views={views}
        activeId={activeViewId}
        onSelect={(id) => {
          const view = views.find((v) => v.id === id)
          if (view) {
            setActiveViewId(id)
            setTree(view.tree)
            setSearch(view.search)
            setCursor(null)
          }
        }}
        onCreate={(name) => {
          const view: SavedViewState = {
            id: crypto.randomUUID(),
            name,
            tree,
            search,
          }
          persistViews([...views, view])
          setActiveViewId(view.id)
        }}
        onRename={(id, name) => persistViews(views.map((v) => (v.id === id ? { ...v, name } : v)))}
        onDelete={(id) => {
          persistViews(views.filter((v) => v.id !== id))
          if (activeViewId === id) setActiveViewId(null)
        }}
      />

      <div className="flex flex-col gap-2">
        <TextField
          value={search}
          onChange={(e) => {
            setSearch(e.currentTarget.value)
            setCursor(null)
          }}
          placeholder="Search tasks…"
          aria-label="Search tasks"
          className="max-w-md"
        />
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex cursor-pointer items-center gap-2">
            <Checkbox
              checked={mineOnly}
              onChange={(e) => {
                setMineOnly(e.currentTarget.checked)
                setCursor(null)
              }}
              aria-label="Only my tasks"
            />
            Only my tasks
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <Checkbox
              checked={overdueOnly}
              onChange={(e) => {
                setOverdueOnly(e.currentTarget.checked)
                setCursor(null)
              }}
              aria-label="Only overdue tasks"
            />
            Only overdue
          </label>
        </div>
        <FilterBuilder
          value={tree}
          onChange={(next) => {
            setTree(next)
            setCursor(null)
          }}
          fields={TASK_FILTER_FIELDS}
        />
      </div>

      {error !== null ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          getRowId={(row) => row.id}
          selectable
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          loading={loading}
          pagination={{ cursor, ...pagination }}
          onPageChange={(next) => setCursor(next)}
          empty={
            <EmptyState
              title={mineOnly ? "No tasks assigned to you" : "No tasks yet"}
              description="Create a task with a title, due date and priority to get started."
              action={
                <Button type="button" onClick={() => setCreateOpen(true)}>
                  New task
                </Button>
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

      <BulkBar selectedCount={selectedIds.length} onClear={() => setSelectedIds([])}>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => setConfirmBulkDelete(true)}
        >
          Delete
        </Button>
      </BulkBar>

      <ConfirmDialog
        open={confirmBulkDelete}
        onOpenChange={setConfirmBulkDelete}
        title={`Delete ${selectedIds.length} tasks?`}
        description="They move to trash and can be restored from the record page."
        confirmLabel="Delete"
        danger
        loading={bulkWorking}
        onConfirm={() => void bulkDelete()}
      />

      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New task"
        description="Required fields first — relations can be added on the detail page."
      >
        <form onSubmit={createTask} className="flex flex-col gap-4">
          <Field label="Title" htmlFor="task-title" required error={createError}>
            <TextField
              id="task-title"
              value={createTitle}
              onChange={(e) => setCreateTitle(e.currentTarget.value)}
              placeholder="Follow up with Acme"
              required
              invalid={createError !== null && createTitle.trim() === ""}
            />
          </Field>
          <Field label="Description" htmlFor="task-description">
            <TextArea
              id="task-description"
              value={createDescription}
              onChange={(e) => setCreateDescription(e.currentTarget.value)}
              placeholder="What needs to happen…"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Priority" htmlFor="task-priority">
              <Select
                id="task-priority"
                value={createPriority}
                onChange={(e) => setCreatePriority(e.currentTarget.value)}
                options={PRIORITY_OPTIONS}
              />
            </Field>
            <Field label="Due date" htmlFor="task-due">
              <DatePicker
                id="task-due"
                value={createDue}
                onChange={(e) => setCreateDue(e.currentTarget.value)}
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={creating}>
              {creating ? "Saving…" : "Create task"}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  )
}
