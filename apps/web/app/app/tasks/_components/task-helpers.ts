import type { FilterCondition, FilterFieldDef, FilterNode, FilterTree } from "@yourcrm/ui"

/** Task record as returned by `GET /api/v1/tasks` (envelope `data` item). */
export type Task = {
  id: string
  workspaceId: string
  title: string
  description: string | null
  status: string
  priority: string
  dueDate: string | null
  completedAt: string | null
  assigneeId: string | null
  ownerId: string | null
  personId: string | null
  companyId: string | null
  dealId: string | null
  createdAt: string
  updatedAt: string
}

export type TasksListResponse = {
  data: Task[]
  pagination: { nextCursor: string | null; limit: number }
}

export type TasksListParams = {
  query?: string
  status?: string
  priority?: string
  mine?: boolean
  overdue?: boolean
}

export const TASK_STATUSES = ["open", "in_progress", "completed", "archived"] as const
export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const

export const TASK_FILTER_FIELDS: FilterFieldDef[] = [
  { name: "title", label: "Title", type: "text" },
  {
    name: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "open", label: "Open" },
      { value: "in_progress", label: "In progress" },
      { value: "completed", label: "Completed" },
      { value: "archived", label: "Archived" },
    ],
  },
  {
    name: "priority",
    label: "Priority",
    type: "select",
    options: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "urgent", label: "Urgent" },
    ],
  },
]

/**
 * Map a UI `FilterTree` onto the P0 list query params. Only `contains`/`eq`
 * leaves on title and `eq`/`in` leaves on `status`/`priority` have server
 * support today; anything else is ignored so the builder stays usable for
 * saved views while structured search grows.
 */
export function treeToTasksParams(tree: FilterTree): Omit<TasksListParams, "mine" | "overdue"> {
  const params: { query?: string; status?: string; priority?: string } = {}
  const visit = (node: FilterNode): void => {
    if (node.type === "group") {
      for (const child of node.children) visit(child)
      return
    }
    const leaf = node as FilterCondition
    if (typeof leaf.value !== "string" || leaf.value.trim() === "") return
    if (leaf.field === "status" && (leaf.operator === "eq" || leaf.operator === "in")) {
      const value = Array.isArray(leaf.value) ? leaf.value[0] : leaf.value
      if ((TASK_STATUSES as readonly string[]).includes(value)) params.status = value
      return
    }
    if (leaf.field === "priority" && (leaf.operator === "eq" || leaf.operator === "in")) {
      const value = Array.isArray(leaf.value) ? leaf.value[0] : leaf.value
      if ((TASK_PRIORITIES as readonly string[]).includes(value)) params.priority = value
      return
    }
    if (leaf.field === "title" && (leaf.operator === "contains" || leaf.operator === "eq")) {
      params.query = params.query === undefined ? leaf.value : `${params.query} ${leaf.value}`
    }
  }
  visit(tree)
  return params
}

/** A task is overdue when it has a past due date and is not completed. */
export function isOverdue(task: Pick<Task, "status" | "dueDate">, now = Date.now()): boolean {
  if (task.status === "completed" || task.status === "archived") return false
  if (!task.dueDate) return false
  return Date.parse(task.dueDate) < now
}

export function formatDueDate(dueDate: string | null): string {
  if (!dueDate) return "No due date"
  return new Date(dueDate).toLocaleDateString()
}

export type { FilterTree }
