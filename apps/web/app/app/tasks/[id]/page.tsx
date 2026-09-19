"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import {
  Badge,
  Button,
  ConfirmDialog,
  DatePicker,
  EmptyState,
  ErrorState,
  Field,
  RecordHeader,
  Select,
  Skeleton,
  Tabs,
  TextArea,
  TextField,
  Timeline,
  toast,
} from "@yourcrm/ui"
import { ApiError, apiFetch } from "@/lib/api-client"
import { formatDueDate, isOverdue, type Task } from "../_components/task-helpers"

const STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
  { value: "archived", label: "Archived" },
]

const PRIORITY_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
]

function toDateInput(value: string | null): string {
  if (!value) return ""
  return new Date(value).toISOString().slice(0, 10)
}

/** Task detail: header, tabbed overview/timeline, edit, complete/reopen, delete. */
export default function TaskDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params.id
  const [task, setTask] = useState<Task | null>(null)
  const [tab, setTab] = useState("overview")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [status, setStatus] = useState("open")
  const [priority, setPriority] = useState("medium")
  const [dueDate, setDueDate] = useState("")
  const [assigneeId, setAssigneeId] = useState("")
  const [saving, setSaving] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<Task>(`/api/v1/tasks/${id}`)
      setTask(data)
      setTitle(data.title)
      setDescription(data.description ?? "")
      setStatus(data.status)
      setPriority(data.priority)
      setDueDate(toDateInput(data.dueDate))
      setAssigneeId(data.assigneeId ?? "")
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this task.")
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (title.trim() === "") {
      toast({ title: "Title is required" })
      return
    }
    setSaving(true)
    try {
      const updated = await apiFetch<Task>(`/api/v1/tasks/${id}`, {
        method: "PATCH",
        body: {
          title: title.trim(),
          description: description.trim() === "" ? null : description.trim(),
          status,
          priority,
          dueDate: dueDate === "" ? null : new Date(dueDate).toISOString(),
          assigneeId: assigneeId.trim() === "" ? null : assigneeId.trim(),
        },
      })
      setTask(updated)
      toast({ title: "Task updated" })
    } catch (err) {
      toast({
        title: "Update failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setSaving(false)
    }
  }

  const toggleComplete = async () => {
    if (!task) return
    setToggling(true)
    try {
      const action = task.status === "completed" ? "reopen" : "complete"
      const updated = await apiFetch<Task>(`/api/v1/tasks/${id}/${action}`, { method: "POST" })
      setTask(updated)
      setStatus(updated.status)
      toast({ title: action === "complete" ? "Task completed" : "Task reopened" })
    } catch (err) {
      toast({
        title: "Could not update the task",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setToggling(false)
    }
  }

  const remove = async () => {
    try {
      await apiFetch(`/api/v1/tasks/${id}`, { method: "DELETE" })
      toast({ title: "Task deleted", description: "It can be restored from trash." })
      router.push("/app/tasks")
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading task">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (error !== null || task === null) {
    return <ErrorState message={error ?? "This task does not exist."} onRetry={() => void load()} />
  }

  const overdue = isOverdue(task)
  const completed = task.status === "completed"

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/tasks" className="text-sm text-muted-foreground hover:underline">
        ← Back to tasks
      </Link>
      <RecordHeader
        title={task.title}
        subtitle={overdue ? "Overdue" : formatDueDate(task.dueDate)}
        status={{
          label: completed ? "completed" : overdue ? "overdue" : task.status.replace("_", " "),
          tone: completed ? "success" : overdue ? "destructive" : "secondary",
        }}
        owner={undefined}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={toggling}
              onClick={() => void toggleComplete()}
            >
              {toggling ? "Saving…" : completed ? "Reopen" : "Complete"}
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
        ariaLabel="Task sections"
        items={[
          {
            value: "overview",
            label: "Overview",
            content: (
              <div className="grid gap-6 py-4 lg:grid-cols-2">
                <div className="flex flex-col gap-6">
                  <section aria-label="Schedule" className="flex flex-col gap-3">
                    <h2 className="text-sm font-semibold">Schedule</h2>
                    <dl className="flex flex-col gap-2 text-sm">
                      <div className="flex items-center gap-2">
                        <dt className="w-24 shrink-0 text-muted-foreground">Due</dt>
                        <dd className={overdue ? "font-medium text-destructive" : undefined}>
                          {formatDueDate(task.dueDate)}
                          {overdue ? (
                            <Badge tone="destructive" className="ml-2">
                              Overdue
                            </Badge>
                          ) : null}
                        </dd>
                      </div>
                      <div className="flex items-center gap-2">
                        <dt className="w-24 shrink-0 text-muted-foreground">Priority</dt>
                        <dd>
                          <Badge tone={task.priority === "urgent" ? "destructive" : "secondary"}>
                            {task.priority}
                          </Badge>
                        </dd>
                      </div>
                      <div className="flex items-center gap-2">
                        <dt className="w-24 shrink-0 text-muted-foreground">Status</dt>
                        <dd>{task.status.replace("_", " ")}</dd>
                      </div>
                      {task.completedAt ? (
                        <div className="flex items-center gap-2">
                          <dt className="w-24 shrink-0 text-muted-foreground">Completed</dt>
                          <dd>{new Date(task.completedAt).toLocaleString()}</dd>
                        </div>
                      ) : null}
                    </dl>
                  </section>
                  <section aria-label="Assignment" className="flex flex-col gap-3">
                    <h2 className="text-sm font-semibold">Assignment</h2>
                    <dl className="flex flex-col gap-2 text-sm">
                      <div className="flex items-center gap-2">
                        <dt className="w-24 shrink-0 text-muted-foreground">Assignee</dt>
                        <dd>{task.assigneeId ?? "Unassigned"}</dd>
                      </div>
                    </dl>
                  </section>
                  <section aria-label="Related records" className="flex flex-col gap-3">
                    <h2 className="text-sm font-semibold">Related records</h2>
                    {task.personId === null && task.companyId === null && task.dealId === null ? (
                      <EmptyState
                        title="No related records"
                        description="Link this task to a person, company or deal when you edit it."
                      />
                    ) : (
                      <dl className="flex flex-col gap-2 text-sm">
                        {task.personId ? (
                          <div className="flex items-center gap-2">
                            <dt className="w-24 shrink-0 text-muted-foreground">Person</dt>
                            <dd>
                              <Link
                                href={`/app/people/${task.personId}`}
                                className="text-primary hover:underline"
                              >
                                {task.personId}
                              </Link>
                            </dd>
                          </div>
                        ) : null}
                        {task.companyId ? (
                          <div className="flex items-center gap-2">
                            <dt className="w-24 shrink-0 text-muted-foreground">Company</dt>
                            <dd>{task.companyId}</dd>
                          </div>
                        ) : null}
                        {task.dealId ? (
                          <div className="flex items-center gap-2">
                            <dt className="w-24 shrink-0 text-muted-foreground">Deal</dt>
                            <dd>{task.dealId}</dd>
                          </div>
                        ) : null}
                      </dl>
                    )}
                    {task.description ? (
                      <div className="flex flex-col gap-1">
                        <h3 className="text-sm font-semibold">Description</h3>
                        <p className="whitespace-pre-wrap text-sm">{task.description}</p>
                      </div>
                    ) : null}
                  </section>
                </div>
                <section aria-label="Edit task">
                  <h2 className="mb-3 text-sm font-semibold">Edit</h2>
                  <form onSubmit={save} className="flex flex-col gap-3">
                    <Field label="Title" htmlFor="task-title">
                      <TextField
                        id="task-title"
                        value={title}
                        onChange={(e) => setTitle(e.currentTarget.value)}
                      />
                    </Field>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Status" htmlFor="task-status">
                        <Select
                          id="task-status"
                          value={status}
                          onChange={(e) => setStatus(e.currentTarget.value)}
                          options={STATUS_OPTIONS}
                        />
                      </Field>
                      <Field label="Priority" htmlFor="task-priority">
                        <Select
                          id="task-priority"
                          value={priority}
                          onChange={(e) => setPriority(e.currentTarget.value)}
                          options={PRIORITY_OPTIONS}
                        />
                      </Field>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Due date" htmlFor="task-due">
                        <DatePicker
                          id="task-due"
                          value={dueDate}
                          onChange={(e) => setDueDate(e.currentTarget.value)}
                        />
                      </Field>
                      <Field label="Assignee id" htmlFor="task-assignee">
                        <TextField
                          id="task-assignee"
                          value={assigneeId}
                          onChange={(e) => setAssigneeId(e.currentTarget.value)}
                          placeholder="Unassigned"
                        />
                      </Field>
                    </div>
                    <Field label="Description" htmlFor="task-description">
                      <TextArea
                        id="task-description"
                        value={description}
                        onChange={(e) => setDescription(e.currentTarget.value)}
                      />
                    </Field>
                    <div>
                      <Button type="submit" disabled={saving}>
                        {saving ? "Saving…" : "Save changes"}
                      </Button>
                    </div>
                  </form>
                </section>
              </div>
            ),
          },
          {
            value: "activity",
            label: "Activity",
            content: (
              <div className="py-4">
                <Timeline
                  items={[
                    {
                      id: "created",
                      actor: "System",
                      timestamp: new Date(task.createdAt).toLocaleString(),
                      dateTime: task.createdAt,
                      body: "Task created.",
                    },
                    ...(task.completedAt
                      ? [
                          {
                            id: "completed",
                            actor: "System",
                            timestamp: new Date(task.completedAt).toLocaleString(),
                            dateTime: task.completedAt,
                            body: "Task completed.",
                          },
                        ]
                      : []),
                    {
                      id: "updated",
                      actor: "System",
                      timestamp: new Date(task.updatedAt).toLocaleString(),
                      dateTime: task.updatedAt,
                      body: "Task last updated.",
                    },
                  ]}
                />
              </div>
            ),
          },
        ]}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${task.title}?`}
        description="The task moves to trash and can be restored."
        confirmLabel="Delete"
        danger
        onConfirm={() => void remove()}
      />
    </div>
  )
}
