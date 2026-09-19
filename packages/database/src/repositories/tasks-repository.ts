import { and, eq, gte, ilike, isNull, lte, lt, ne, or, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import { isTaskPriority, isTaskStatus, tasks, type NewTask, type Task } from "../schema/tasks"
import { createBaseRepository } from "./base-repository"

export type CreateTaskInput = {
  title: string
  description?: string | null
  status?: string | null
  priority?: string | null
  dueDate?: Date | string | null
  assigneeId?: string | null
  ownerId?: string | null
  personId?: string | null
  companyId?: string | null
  dealId?: string | null
}

export type UpdateTaskInput = Partial<
  Pick<
    NewTask,
    | "title"
    | "description"
    | "dueDate"
    | "completedAt"
    | "assigneeId"
    | "ownerId"
    | "personId"
    | "companyId"
    | "dealId"
  >
> & {
  status?: string | null
  priority?: string | null
}

/** Trimmed, non-empty title (max 255, mirrors the column). */
export function normalizeTaskTitle(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new Error("tasks.create: title must not be empty")
  if (trimmed.length > 255) throw new Error("tasks.create: title must be at most 255 characters")
  return trimmed
}

function toDate(value: Date | string | null | undefined, field: string): Date | null | undefined {
  if (value === undefined || value === null) return value ?? undefined
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`tasks.create: ${field} must be a valid date`)
  return date
}

function toTaskValues(
  workspaceId: string,
  input: CreateTaskInput | UpdateTaskInput,
  actorId?: string,
): Partial<NewTask> {
  const values: Partial<NewTask> = {}
  if (input.title !== undefined) values.title = normalizeTaskTitle(input.title)
  if (input.description !== undefined) values.description = input.description ?? null
  if (input.status !== undefined) {
    if (input.status !== null && !isTaskStatus(input.status)) {
      throw new Error(
        `tasks.create: status must be one of ${["open", "in_progress", "completed", "archived"].join(", ")}`,
      )
    }
    values.status = input.status ?? "open"
  }
  if (input.priority !== undefined) {
    if (input.priority !== null && !isTaskPriority(input.priority)) {
      throw new Error(`tasks.create: priority must be one of low, medium, high, urgent`)
    }
    values.priority = input.priority ?? "medium"
  }
  if (input.dueDate !== undefined) {
    const date = toDate(input.dueDate, "dueDate")
    if (date !== undefined) values.dueDate = date
  }
  if (input.assigneeId !== undefined) values.assigneeId = input.assigneeId
  if (input.ownerId !== undefined) values.ownerId = input.ownerId
  if (input.personId !== undefined) values.personId = input.personId
  if (input.companyId !== undefined) values.companyId = input.companyId
  if (input.dealId !== undefined) values.dealId = input.dealId
  if (actorId !== undefined) {
    values.updatedBy = actorId
  }
  return { ...values, workspaceId }
}

/**
 * Workspace-scoped tasks. Cross-module references (`personId`, `companyId`,
 * `dealId`) stay plain columns with no joins until those modules land; tags,
 * custom fields and relationships attach via the shared repositories.
 */
export function createTasksRepository() {
  const base = createBaseRepository(tasks)

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateTaskInput,
      actorId?: string,
    ): Promise<Task> {
      const rows = await db
        .insert(tasks)
        .values({
          ...toTaskValues(workspaceId, input, actorId),
          workspaceId,
          title: normalizeTaskTitle(input.title),
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("tasks.create: insert returned no rows")
      return row
    },

    /** Cursor-paginated list with search + status/priority/assignee/due filters. */
    async search(
      db: Database,
      opts: { workspaceId: string; limit?: number; cursor?: string; order?: "asc" | "desc" } & {
        query?: string
        status?: string
        priority?: string
        assigneeId?: string
        overdue?: boolean
        dueBefore?: string
        dueAfter?: string
      },
    ) {
      const conditions: SQL[] = []
      if (opts.query) {
        const q = `%${opts.query.trim()}%`
        const textMatch = or(ilike(tasks.title, q), ilike(tasks.description, q))
        if (textMatch) conditions.push(textMatch)
      }
      if (opts.status) {
        if (!isTaskStatus(opts.status)) throw new Error("tasks.search: unknown status filter")
        conditions.push(eq(tasks.status, opts.status))
      }
      if (opts.priority) {
        if (!isTaskPriority(opts.priority)) throw new Error("tasks.search: unknown priority filter")
        conditions.push(eq(tasks.priority, opts.priority))
      }
      if (opts.assigneeId) conditions.push(eq(tasks.assigneeId, opts.assigneeId))
      if (opts.overdue) {
        conditions.push(ne(tasks.status, "completed"))
        conditions.push(lt(tasks.dueDate, new Date()))
      }
      if (opts.dueBefore) {
        const date = toDate(opts.dueBefore, "dueBefore")
        if (date) conditions.push(lte(tasks.dueDate, date))
      }
      if (opts.dueAfter) {
        const date = toDate(opts.dueAfter, "dueAfter")
        if (date) conditions.push(gte(tasks.dueDate, date))
      }
      const result = await base.list(db, { ...opts, where: conditions })
      return { data: result.data as Task[], pagination: result.pagination }
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateTaskInput,
      actorId?: string,
    ): Promise<Task | null> {
      const rows = await db
        .update(tasks)
        .set({ ...toTaskValues(workspaceId, input, actorId), updatedAt: new Date() })
        .where(and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt)))
        .returning()
      return rows[0] ?? null
    },

    async findById(db: Database, workspaceId: string, id: string): Promise<Task | null> {
      // The shared base narrows rows to the BaseRecord columns; re-select the
      // concrete table here so callers get the full Task shape.
      const row = await base.findById(db, workspaceId, id)
      return (row as Task | null) ?? null
    },
  }
}

export type TasksRepository = ReturnType<typeof createTasksRepository>
